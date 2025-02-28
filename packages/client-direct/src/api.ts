import express from "express";
import bodyParser from "body-parser";
import cors from "cors";

import {
    AgentRuntime,
    elizaLogger,
    getEnvVariable,
    UUID,
    validateCharacterConfig,
    ServiceType,
    // IDatabaseAdapter,
} from "@elizaos/core";

import { TeeLogQuery, TeeLogService } from "@elizaos/plugin-tee-log";
import { REST, Routes } from "discord.js";
import { DirectClient } from ".";
import { validateUuid } from "@elizaos/core";

interface UUIDParams {
    agentId: UUID;
    roomId?: UUID;
}

function validateUUIDParams(
    params: { agentId: string; roomId?: string },
    res: express.Response
): UUIDParams | null {
    const agentId = validateUuid(params.agentId);
    if (!agentId) {
        res.status(400).json({
            error: "Invalid AgentId format. Expected to be a UUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        });
        return null;
    }

    if (params.roomId) {
        const roomId = validateUuid(params.roomId);
        if (!roomId) {
            res.status(400).json({
                error: "Invalid RoomId format. Expected to be a UUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
            });
            return null;
        }
        return { agentId, roomId };
    }

    return { agentId };
}

export function createApiRouter(
    agents: Map<string, AgentRuntime>,
    directClient: DirectClient,
    // db: IDatabaseAdapter
) {
    const router = express.Router();

    router.use(cors());
    router.use(bodyParser.json());
    router.use(bodyParser.urlencoded({ extended: true }));
    router.use(
        express.json({
            limit: getEnvVariable("EXPRESS_MAX_PAYLOAD") || "100kb",
        })
    );

    router.get("/", (req, res) => {
        res.send("Welcome, this is the REST API!");
    });

    router.get("/hello", (req, res) => {
        res.json({ message: "Hello World!" });
    });

    router.get("/agents", (req, res) => {
        const agentsList = Array.from(agents.values()).map((agent) => ({
            id: agent.agentId,
            name: agent.character.name,
            clients: Object.keys(agent.clients),
        }));
        res.json({ agents: agentsList });
    });

    router.get("/agents/:agentId", (req, res) => {
        const { agentId } = validateUUIDParams(req.params, res) ?? {
            agentId: null,
        };
        if (!agentId) return;

        const agent = agents.get(agentId);

        if (!agent) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        const character = agent?.character;
        if (character?.settings?.secrets) {
            delete character.settings.secrets;
        }

        res.json({
            id: agent.agentId,
            character: agent.character,
        });
    });

    router.post("/agents/:agentId/set", async (req, res) => {
        const { agentId } = validateUUIDParams(req.params, res) ?? {
            agentId: null,
        };
        if (!agentId) return;

        let agent: AgentRuntime = agents.get(agentId);

        // update character
        if (agent) {
            // stop agent
            agent.stop();
            directClient.unregisterAgent(agent);
            // if it has a different name, the agentId will change
        }

        // load character from body
        const character = req.body;
        try {
            validateCharacterConfig(character);
        } catch (e) {
            elizaLogger.error(`Error parsing character: ${e}`);
            res.status(400).json({
                success: false,
                message: e.message,
            });
            return;
        }

        // start it up (and register it)
        agent = await directClient.startAgent(character);
        elizaLogger.log(`${character.name} started`);

        res.json({
            id: character.id,
            character: character,
        });
    });

    router.get("/agents/:agentId/channels", async (req, res) => {
        const { agentId } = validateUUIDParams(req.params, res) ?? {
            agentId: null,
        };
        if (!agentId) return;

        const runtime = agents.get(agentId);

        if (!runtime) {
            res.status(404).json({ error: "Runtime not found" });
            return;
        }

        const API_TOKEN = runtime.getSetting("DISCORD_API_TOKEN") as string;
        const rest = new REST({ version: "10" }).setToken(API_TOKEN);

        try {
            const guilds = (await rest.get(Routes.userGuilds())) as Array<any>;

            res.json({
                id: runtime.agentId,
                guilds: guilds,
                serverCount: guilds.length,
            });
        } catch (error) {
            console.error("Error fetching guilds:", error);
            res.status(500).json({ error: "Failed to fetch guilds" });
        }
    });


    router.get("/agents/:agentId/:roomId/memories", async (req, res) => {
        const { agentId, roomId } = validateUUIDParams(req.params, res) ?? {
            agentId: null,
            roomId: null,
        };
        if (!agentId || !roomId) return;

        let runtime = agents.get(agentId);

        // if runtime is null, look for runtime with the same name
        if (!runtime) {
            runtime = Array.from(agents.values()).find(
                (a) => a.character.name.toLowerCase() === agentId.toLowerCase()
            );
        }

        if (!runtime) {
            res.status(404).send("Agent not found");
            return;
        }

        try {
            const memories = await runtime.messageManager.getMemories({
                roomId,
                count: 50,
                unique: false
            });

            const response = {
                agentId,
                roomId,
                memories: memories.map((memory) => ({
                    id: memory.id,
                    userId: memory.userId,
                    agentId: memory.agentId,
                    createdAt: memory.createdAt,
                    content: {
                        text: memory.content.text,
                        action: memory.content.action,
                        source: memory.content.source,
                        url: memory.content.url,
                        inReplyTo: memory.content.inReplyTo,
                        attachments: memory.content.attachments?.map(
                            (attachment) => ({
                                id: attachment.id,
                                url: attachment.url,
                                title: attachment.title,
                                source: attachment.source,
                                description: attachment.description,
                                text: attachment.text,
                                contentType: attachment.contentType,
                            })
                        ),
                    },
                    roomId: memory.roomId,
                    unique: memory.unique,
                    similarity: memory.similarity,
                })),
            };

            res.json(response);
        } catch (error) {
            console.error("Error fetching memories:", error);
            res.status(500).json({ error: "Failed to fetch memories" });
        }
    });


    router.get("/agents/:agentId/chat-history", async (req, res) => {
        const { agentId } = validateUUIDParams(req.params, res) ?? {
            agentId: null,
        };
        const username = req.query.username as string;

        if (!agentId || !username) {
            return res.status(400).json({ error: "Missing required parameters" });
        }

        try {
            // Get the agent runtime
            let runtime = agents.get(agentId);

            // If runtime is null, look for runtime with the same name (following existing pattern)
            if (!runtime) {
                runtime = Array.from(agents.values()).find(
                    (a) => a.character.name.toLowerCase() === agentId.toLowerCase()
                );
            }

            if (!runtime) {
                return res.status(404).json({ error: "Agent not found" });
            }

            // Find the user account by username
            const account = await (runtime.databaseAdapter as any).getAccountByUsername(username);
            if (!account) {
                return res.status(404).json({ error: "User not found" });
            }

            const userId = account.id;

            // Get rooms where the user is a participant
            const userRooms = await runtime.databaseAdapter.getRoomsForParticipant(userId);

            if (!userRooms || userRooms.length === 0) {
                return res.status(404).json({ error: "No chat rooms found for this user" });
            }

            // Find a room where both the user and agent participate, but the room ID is not equal to the agent ID
            let sharedRoom: UUID | null = null;

            for (const roomId of userRooms) {
                // Skip rooms that are the agent's "self-room"
                if (roomId === agentId) {
                    continue;
                }

                // Check if the agent is also a participant in this room
                const participants = await runtime.databaseAdapter.getParticipantsForRoom(roomId);
                if (participants.includes(agentId)) {
                    sharedRoom = roomId;
                    break;
                }
            }

            if (!sharedRoom) {
                return res.status(404).json({ error: "No shared chat room found for this user and agent" });
            }

            // Get the most recent chat history from the shared room
            const roomId = sharedRoom;
            const count = parseInt(req.query.count as string) || 50;

            // Get all memories in the room
            const allMemories = await runtime.messageManager.getMemories({
                roomId,
                count: count * 2, // Double the count to account for filtering
                unique: false
            });

            // Filter messages to include only:
            // 1. Messages from the user to this agent
            // 2. Messages from the agent where the username property matches
            const filteredMemories = allMemories.filter(memory =>
                // User messages to this agent
                (memory.userId === userId && memory.agentId === agentId) ||
                // Agent responses specifically for this user
                (memory.userId === agentId && memory.agentId === agentId &&
                 memory.content.username === username)
            );

            // Limit to the requested count
            const memories = filteredMemories.slice(0, count);

            // Format response using the same structure as other endpoints
            const response = {
                agentId,
                roomId,
                userId,
                memories: memories.map((memory) => ({
                    id: memory.id,
                    userId: memory.userId,
                    agentId: memory.agentId,
                    createdAt: memory.createdAt,
                    content: {
                        text: memory.content.text,
                        action: memory.content.action,
                        source: memory.content.source,
                        url: memory.content.url,
                        inReplyTo: memory.content.inReplyTo,
                        username: memory.content.username,
                        attachments: memory.content.attachments?.map(
                            (attachment) => ({
                                id: attachment.id,
                                url: attachment.url,
                                title: attachment.title,
                                source: attachment.source,
                                description: attachment.description,
                                text: attachment.text,
                                contentType: attachment.contentType,
                            })
                        ),
                    },
                    roomId: memory.roomId,
                    unique: memory.unique,
                    similarity: memory.similarity,
                })),
            };

            res.json(response);
        } catch (error) {
            elizaLogger.error("Error fetching chat history:", error);
            res.status(500).json({ error: "Failed to fetch chat history", details: error.message });
        }
    });


    router.get("/agents/:agentId/:roomId/:userId/memories", async (req, res) => {
        const { agentId, roomId} = validateUUIDParams(req.params, res) ?? {
            agentId: null,
            roomId: null,
        };
        const userId = validateUuid(req.params.userId);

        const count = parseInt(req.query.count as string) || 10;
        if (!agentId || !roomId || !userId) return;

        let runtime = agents.get(agentId);

        // if runtime is null, look for runtime with the same name
        if (!runtime) {
            runtime = Array.from(agents.values()).find(
                (a) => a.character.name.toLowerCase() === agentId.toLowerCase()
            );
        }

        if (!runtime) {
            res.status(404).send("Agent not found");
            return;
        }

        try {
            const memories = await runtime.messageManager.getMemories({
                roomId,
                unique: false,
                userId,
                count
            });

            const response = {
                agentId,
                roomId,
                memories: memories.map((memory) => ({
                    id: memory.id,
                    userId: memory.userId,
                    agentId: memory.agentId,
                    createdAt: memory.createdAt,
                    content: {
                        text: memory.content.text,
                        action: memory.content.action,
                        source: memory.content.source,
                        url: memory.content.url,
                        inReplyTo: memory.content.inReplyTo,
                        attachments: memory.content.attachments?.map(
                            (attachment) => ({
                                id: attachment.id,
                                url: attachment.url,
                                title: attachment.title,
                                source: attachment.source,
                                description: attachment.description,
                                text: attachment.text,
                                contentType: attachment.contentType,
                            })
                        ),
                    },
                    roomId: memory.roomId,
                    unique: memory.unique,
                    similarity: memory.similarity,
                })),
            };

            res.json(response);
        } catch (error) {
            console.error("Error fetching memories:", error);
            res.status(500).json({ error: "Failed to fetch memories" });
        }
    });




    router.get("/tee/agents", async (req, res) => {
        try {
            const allAgents = [];

            for (const agentRuntime of agents.values()) {
                const teeLogService = agentRuntime
                    .getService<TeeLogService>(
                    ServiceType.TEE_LOG
                )
                .getInstance();

                const agents = await teeLogService.getAllAgents();
                allAgents.push(...agents)
            }

            const runtime: AgentRuntime = agents.values().next().value;
            const teeLogService = runtime.getService<TeeLogService>(ServiceType.TEE_LOG).getInstance();
            const attestation = await teeLogService.generateAttestation(JSON.stringify(allAgents));
            res.json({ agents: allAgents, attestation: attestation });
        } catch (error) {
            elizaLogger.error("Failed to get TEE agents:", error);
            res.status(500).json({
                error: "Failed to get TEE agents",
            });
        }
    });

    router.get("/tee/agents/:agentId", async (req, res) => {
        try {
            const agentId = req.params.agentId;
            const agentRuntime = agents.get(agentId);
            if (!agentRuntime) {
                res.status(404).json({ error: "Agent not found" });
                return;
            }

            const teeLogService = agentRuntime
                .getService<TeeLogService>(
                ServiceType.TEE_LOG
            )
            .getInstance();

            const teeAgent = await teeLogService.getAgent(agentId);
            const attestation = await teeLogService.generateAttestation(JSON.stringify(teeAgent));
            res.json({ agent: teeAgent, attestation: attestation });
        } catch (error) {
            elizaLogger.error("Failed to get TEE agent:", error);
            res.status(500).json({
                error: "Failed to get TEE agent",
            });
        }
    });

    router.post(
        "/tee/logs",
        async (req: express.Request, res: express.Response) => {
            try {
                const query = req.body.query || {};
                const page = parseInt(req.body.page) || 1;
                const pageSize = parseInt(req.body.pageSize) || 10;

                const teeLogQuery: TeeLogQuery = {
                    agentId: query.agentId || "",
                    roomId: query.roomId || "",
                    userId: query.userId || "",
                    type: query.type || "",
                    containsContent: query.containsContent || "",
                    startTimestamp: query.startTimestamp || undefined,
                    endTimestamp: query.endTimestamp || undefined,
                };
                const agentRuntime: AgentRuntime = agents.values().next().value;
                const teeLogService = agentRuntime
                    .getService<TeeLogService>(
                        ServiceType.TEE_LOG
                    )
                    .getInstance();
                const pageQuery = await teeLogService.getLogs(teeLogQuery, page, pageSize);
                const attestation = await teeLogService.generateAttestation(JSON.stringify(pageQuery));
                res.json({
                    logs: pageQuery,
                    attestation: attestation,
                });
            } catch (error) {
                elizaLogger.error("Failed to get TEE logs:", error);
                res.status(500).json({
                    error: "Failed to get TEE logs",
                });
            }
        }
    );

    return router;
}
