import {
    DynamoDBClient,
    PutItemCommand,
    DeleteItemCommand,
    GetItemCommand,
    UpdateItemCommand,
    ScanCommand,
} from '@aws-sdk/client-dynamodb';
import {
    ApiGatewayManagementApiClient,
    PostToConnectionCommand,
    DeleteConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';

import type {
    GameSession,
    GamePhase,
    QuestionPick,
    SessionUser,
    UsernameConflictAction,
    WsHandlerEvent,
} from './types';

const ddb = new DynamoDBClient({});

const SESSION_ID = 'default';
// Up to 12 distinct player colors; new joins get the first palette slot not already taken (works after kicks).
const COLORS = [
    '#f44336',
    '#2196f3',
    '#4caf50',
    '#ff9800',
    '#9c27b0',
    '#00bcd4',
    '#e91e63',
    '#8bc34a',
    '#ffc107',
    '#009688',
    '#795548',
    '#607d8b',
];

function pickAvailableColor(users: Pick<SessionUser, 'color'>[]): string {
    const used = new Set(users.map((u) => u.color));
    const free = COLORS.find((c) => !used.has(c));
    if (free) return free;
    return COLORS[users.length % COLORS.length];
}

function getUsernameForConnection(session: GameSession, connectionId: string): string | null {
    const u = session.users.find((x) => x.connectionId === connectionId);
    return u?.username ?? null;
}

/** If no admin or current admin left the lobby, set admin to first user; clear if lobby empty. */
function ensureAdminForSession(session: GameSession): void {
    if (!session.users.length) {
        session.adminUsername = null;
        return;
    }
    const current = session.adminUsername;
    const stillThere = current && session.users.some((u) => u.username === current);
    if (!stillThere) {
        session.adminUsername = session.users[0].username;
    }
}

// ── Structured logging (CloudWatch / Logs Insights) ──
function wsLog(event: WsHandlerEvent, fields: Record<string, unknown>): void {
    const base: Record<string, unknown> = {
        scope: 'ws',
        requestId: event.requestContext?.requestId,
        connectionId: event.requestContext?.connectionId,
        routeKey: event.requestContext?.routeKey,
    };
    console.log(JSON.stringify({ ...base, ...fields }));
}

// ── Helpers ──
// This is a helper function to get the APIGW client
// which is used to send messages to the users
const getApigwClient = (event: WsHandlerEvent) => {
    const domain = event.requestContext.domainName;
    const stage = event.requestContext.stage;
    return new ApiGatewayManagementApiClient({
        endpoint: `https://${domain}/${stage}`,
    });
};

async function getOrCreateSession(): Promise<GameSession> {
    // Gets session from sessions table - this is a PUT so it
    // creates one if doesn't exist
    const result = await ddb.send(
        new GetItemCommand({
            TableName: process.env.GAME_SESSIONS_TABLE!,
            Key: { sessionId: { S: SESSION_ID } },
        }),
    );

    if (result.Item) {
        return {
            sessionId: SESSION_ID,
            state: (result.Item.state?.S ?? 'LOBBY') as GamePhase,
            users: JSON.parse(result.Item.users?.S ?? '[]') as SessionUser[],
            roundData: result.Item.roundData?.S
                ? (JSON.parse(result.Item.roundData.S) as GameSession['roundData'])
                : null,
            usedQuestionIds: JSON.parse(result.Item.usedQuestionIds?.S ?? '[]') as string[],
            excludedRanges: JSON.parse(result.Item.excludedRanges?.S ?? '[]') as string[],
            safeMode: result.Item.safeMode?.BOOL === true,
            adminUsername: result.Item.adminUsername?.S ?? null,
        };
    }
    return {
        sessionId: SESSION_ID,
        state: 'LOBBY',
        users: [],
        roundData: null,
        usedQuestionIds: [],
        excludedRanges: [],
        safeMode: false,
        adminUsername: null,
    };
}

// This is a helper function to save the session to the database
async function saveSession(session: GameSession): Promise<void> {
    const item: Record<string, any> = {
        sessionId: { S: session.sessionId },
        state: { S: session.state },
        users: { S: JSON.stringify(session.users) },
        usedQuestionIds: { S: JSON.stringify(session.usedQuestionIds ?? []) },
        excludedRanges: { S: JSON.stringify(session.excludedRanges ?? []) },
        safeMode: { BOOL: session.safeMode === true },
    };
    if (session.adminUsername) {
        item.adminUsername = { S: session.adminUsername };
    }
    if (session.roundData) {
        item.roundData = { S: JSON.stringify(session.roundData) };
    }
    await ddb.send(
        new PutItemCommand({
            TableName: process.env.GAME_SESSIONS_TABLE!,
            Item: item,
        }),
    );
}

async function resolveUsernameConflict(
    session: GameSession,
    username: string,
    connectionId: string,
    event: WsHandlerEvent,
): Promise<{ action: UsernameConflictAction }> {
    const existing = session.users.find((u) => u.username === username);
    // if the user is not found, we can add them to the session
    if (!existing) {
        wsLog(event, {
            phase: 'resolveUsernameConflict',
            username,
            hadExistingUser: false,
            resolution: 'add',
            oldConnActive: null,
        });
        return { action: 'add' }; // New user
    }
    // if the user is found, and the connectionId is the same, we can return that the user is already in
    if (existing.connectionId === connectionId) {
        wsLog(event, {
            phase: 'resolveUsernameConflict',
            username,
            hadExistingUser: true,
            storedConnectionId: existing.connectionId,
            resolution: 'idempotent',
            oldConnActive: null,
        });
        return { action: 'idempotent' };
    }
    // if the user is found, and the connectionId is different, we can check if the old connection is still active
    // when a user disconnects, the connection is deleted from the connections table
    // So, if the connection is deleted, we can reconnect the user by updating the connectionId in the sessions table for the user,
    // and adding the new connectionId to the connections table
    const oldConnActive = await ddb
        .send(
            new GetItemCommand({
                TableName: process.env.CONNECTIONS_TABLE!,
                Key: { connectionId: { S: existing.connectionId } },
            }),
        )
        .then((r) => !!r.Item);
    const resolution = oldConnActive ? 'reject' : 'reconnect';
    wsLog(event, {
        phase: 'resolveUsernameConflict',
        username,
        hadExistingUser: true,
        storedConnectionId: existing.connectionId,
        oldConnActive,
        resolution,
    });
    // if the old connection is still active, we can reject the new connection
    // if the old connection is not active, we can reconnect the user
    return oldConnActive ? { action: 'reject' } : { action: 'reconnect' };
}

// this is how we send information to the users
/** Close a WebSocket and remove its Connections row (kick). */
async function forceDisconnectConnection(event: WsHandlerEvent, connectionId: string): Promise<void> {
    const client = getApigwClient(event);
    try {
        await client.send(new DeleteConnectionCommand({ ConnectionId: connectionId }));
    } catch (err: any) {
        if (err.$metadata?.httpStatusCode === 410 || err.name === 'GoneException') {
            // already gone
        } else {
            console.error('DeleteConnection failed:', err);
        }
    }
    try {
        await ddb.send(
            new DeleteItemCommand({
                TableName: process.env.CONNECTIONS_TABLE!,
                Key: { connectionId: { S: connectionId } },
            }),
        );
    } catch (err) {
        console.error('DeleteItem connection after kick:', err);
    }
}

async function sendToConnection(event: WsHandlerEvent, connectionId: string, payload: unknown): Promise<void> {
    const client = getApigwClient(event);
    try {
        await client.send(
            new PostToConnectionCommand({
                ConnectionId: connectionId,
                Data: Buffer.from(JSON.stringify(payload)),
            }),
        );
    } catch (err: any) {
        if (err.$metadata?.httpStatusCode === 410 || err.name === 'GoneException') {
            wsLog(event, {
                phase: 'post_to_connection',
                targetConnectionId: connectionId,
                stale: true,
                payloadType:
                    typeof payload === 'object' && payload !== null && 'type' in payload
                        ? (payload as { type?: string }).type
                        : undefined,
            });
        } else {
            throw err;
        }
    }
}

/** Send ERROR to client and log `clientError` for CloudWatch; marks `clientSuccess: false` on request_complete. */
async function sendClientError(
    event: WsHandlerEvent,
    connectionId: string,
    message: string,
    extra?: Record<string, unknown>,
): Promise<void> {
    const meta = event.imposterInvokeMeta;
    if (meta) meta.clientErrorSent = true;
    wsLog(event, {
        phase: 'client_error',
        clientError: message,
        ...extra,
    });
    await sendToConnection(event, connectionId, { type: 'ERROR', message });
}

/** Thrown when no range has 2+ eligible questions (after used / excluded filters). */
const NO_PAIRS_AVAILABLE = 'NO_PAIRS_AVAILABLE';

/** Select two questions with the same range (one correct, one imposter). */
function isQuestionUnsafe(q: Record<string, { S?: string; BOOL?: boolean } | undefined>): boolean {
    if (q.safe?.BOOL === false) return true;
    if (q.safe?.S === 'false') return true;
    return false;
}

async function selectQuestionPair(
    usedQuestionIds: string[],
    excludedRanges: string[],
    safeMode: boolean,
): Promise<QuestionPick> {
    const used = new Set(usedQuestionIds);
    const excluded = new Set(excludedRanges);

    const result = await ddb.send(new ScanCommand({ TableName: process.env.QUESTIONS_TABLE! }));
    const questions = (result.Items ?? [])
        .map((q: Record<string, { S?: string; BOOL?: boolean }>) => ({
            questionId: q.questionId?.S ?? '',
            question: q.question?.S ?? '',
            range: q.range?.S ?? 'unknown',
            raw: q,
        }))
        .filter((q) => {
            if (!q.questionId || used.has(q.questionId) || excluded.has(q.range)) return false;
            if (safeMode && isQuestionUnsafe(q.raw)) return false;
            return true;
        });

    const byRange: Record<string, { questionId: string; question: string; range: string }[]> = {};
    for (const q of questions) {
        const slim = { questionId: q.questionId, question: q.question, range: q.range };
        if (!byRange[q.range]) byRange[q.range] = [];
        byRange[q.range].push(slim);
    }

    const validRanges = Object.keys(byRange).filter((r) => byRange[r].length >= 2);
    if (validRanges.length === 0) {
        const err = new Error(NO_PAIRS_AVAILABLE);
        err.name = 'NoQuestionPairsError';
        throw err;
    }

    const range = validRanges[Math.floor(Math.random() * validRanges.length)];
    const pool = byRange[range];
    const i = Math.floor(Math.random() * pool.length);
    let j = Math.floor(Math.random() * (pool.length - 1));
    if (j >= i) j += 1;

    return { correct: pool[i], imposter: pool[j] };
}

/** Reset in-memory session to empty lobby (caller must saveSession). */
function applySessionWipe(session: GameSession): void {
    session.state = 'LOBBY';
    session.roundData = null;
    session.users = [];
    session.usedQuestionIds = [];
    session.excludedRanges = [];
    session.safeMode = false;
    session.adminUsername = null;
}

/**
 * If no registered player still has a row in Connections, clear the game session.
 * Does not send GAME_ENDED (no clients to reach). Call after removing the disconnecting connection.
 *
 * NOTE: This does O(players) GetItem calls per disconnect. If you scale to many rooms/users,
 * consider a GSI on sessionId, connection TTL, or a single "active count" counter instead.
 */
/** LOBBY only: remove disconnecting player from roster and reassign admin. (Optional; not wired in $disconnect currently.) */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for future lobby prune on disconnect
async function removeLobbyUserOnDisconnect(connectionId: string, event: WsHandlerEvent): Promise<void> {
    const session = await getOrCreateSession();
    if (session.state !== 'LOBBY') return;
    const idx = session.users.findIndex((u) => u.connectionId === connectionId);
    if (idx === -1) return;
    session.users.splice(idx, 1);
    ensureAdminForSession(session);
    await saveSession(session);
    await broadcastLobbyUpdate(event, session);
}

// async function abandonSessionIfEveryoneDisconnected(): Promise<void> {
//     const session = await getOrCreateSession();
//     if (!session.users?.length) return;

//     for (const user of session.users) {
//         const conn = await ddb.send(
//             new GetItemCommand({
//                 TableName: process.env.CONNECTIONS_TABLE!,
//                 Key: { connectionId: { S: user.connectionId } },
//             }),
//         );
//         if (conn.Item) return;
//     }

//     applySessionWipe(session);
//     await saveSession(session);
// }

async function broadcastLobbyUpdate(event: WsHandlerEvent, session: GameSession): Promise<void> {
    const payload = {
        type: 'LOBBY_UPDATE',
        data: session.users.map((u) => ({ username: u.username, color: u.color, score: u.score })),
        safeMode: session.safeMode === true,
        adminUsername: session.adminUsername ?? null,
    };
    await Promise.all(session.users.map((user) => sendToConnection(event, user.connectionId, payload)));
}

/**
 * After mid-game reconnect, send this socket the same messages it would have had if still connected
 * (matches payloads from handleStartRound / handleSubmitAnswer / handleVote).
 */
async function sendSessionCatchUp(
    event: WsHandlerEvent,
    connectionId: string,
    session: GameSession,
    username: string,
): Promise<void> {
    const rd = session.roundData;

    switch (session.state) {
        case 'LOBBY': {
            await sendToConnection(event, connectionId, {
                type: 'LOBBY_UPDATE',
                data: session.users.map((u) => ({ username: u.username, color: u.color, score: u.score })),
                safeMode: session.safeMode === true,
                adminUsername: session.adminUsername ?? null,
            });
            return;
        }
        case 'QUESTION': {
            if (!rd) return;
            const question =
                username === rd.imposterUsername ? rd.imposterQuestion.question : rd.correctQuestion.question;
            await sendToConnection(event, connectionId, { type: 'QUESTION_ASSIGNMENT', question });
            const alreadyAnswered = rd.answersSubmitted?.some((a) => a.username === username);
            if (alreadyAnswered) {
                await sendToConnection(event, connectionId, { type: 'ANSWER_CONFIRMED' });
            }
            return;
        }
        case 'VOTING': {
            if (!rd) return;
            await sendToConnection(event, connectionId, {
                type: 'ROUND_UPDATE',
                state: 'VOTING',
                data: {
                    correctQuestion: rd.correctQuestion.question,
                    answersSubmitted: rd.answersSubmitted,
                },
            });
            const alreadyVoted = rd.votes?.some((v) => v.username === username);
            if (alreadyVoted) {
                await sendToConnection(event, connectionId, { type: 'VOTE_CONFIRMED' });
            }
            return;
        }
        case 'RESULT': {
            if (!rd) return;
            const imposterUsername = rd.imposterUsername;
            const votesForImposter = rd.votes.filter((v) => v.target === imposterUsername).length;
            const majorityCaught = votesForImposter > session.users.length / 2;
            await sendToConnection(event, connectionId, {
                type: 'ROUND_UPDATE',
                state: 'RESULT',
                data: {
                    imposterUsername,
                    success: majorityCaught,
                    updatedScores: session.users.map((u) => ({ username: u.username, score: u.score })),
                },
            });
            return;
        }
        default:
            return;
    }
}

// ── Action Handlers ──
async function handleStartRound(connectionId: string, body: any, event: WsHandlerEvent): Promise<void> {
    const session = await getOrCreateSession();

    const requester = getUsernameForConnection(session, connectionId);
    if (!requester || requester !== session.adminUsername) {
        await sendClientError(event, connectionId, 'Only the lobby admin can start a round.', {
            action: 'START_ROUND',
        });
        return;
    }

    // check if the game is in the lobby
    if (session.state !== 'LOBBY') {
        await sendClientError(event, connectionId, 'Round already in progress. Use Return to Lobby first.', {
            action: 'START_ROUND',
        });
        return;
    }

    // check if there are at least 3 players to start
    if (session.users.length < 3) {
        await sendClientError(event, connectionId, 'Need at least 3 players to start.', { action: 'START_ROUND' });
        return;
    }

    // select question pair and imposter (no repeat; excludedRanges respected). Out of pairs → end game for everyone.
    const used = [...(session.usedQuestionIds ?? [])];
    const excluded = session.excludedRanges ?? [];
    let questionPair: QuestionPick;
    try {
        questionPair = await selectQuestionPair(used, excluded, session.safeMode === true);
    } catch (err: any) {
        if (err.message === NO_PAIRS_AVAILABLE) {
            await Promise.all(
                session.users.map((user) => sendToConnection(event, user.connectionId, { type: 'GAME_ENDED' })),
            );
            applySessionWipe(session);
            await saveSession(session);
            return;
        }
        await sendClientError(event, connectionId, `Failed to select questions: ${err.message}`, {
            action: 'START_ROUND',
        });
        return;
    }
    session.usedQuestionIds = [...used, questionPair.correct.questionId, questionPair.imposter.questionId];
    const imposterIndex = Math.floor(Math.random() * session.users.length);
    const imposterUsername = session.users[imposterIndex].username;

    session.state = 'QUESTION';
    session.roundData = {
        correctQuestion: questionPair.correct,
        imposterQuestion: questionPair.imposter,
        imposterUsername,
        answersSubmitted: [],
        votes: [],
    };

    await saveSession(session);

    // send question to each user
    // this is also how users will know to progress to question screen
    await Promise.all(
        session.users.map((user) => {
            const question =
                user.username === imposterUsername ? questionPair.imposter.question : questionPair.correct.question;
            return sendToConnection(event, user.connectionId, {
                type: 'QUESTION_ASSIGNMENT',
                question,
            });
        }),
    );
}

async function handleSubmitAnswer(connectionId: string, body: any, event: WsHandlerEvent): Promise<void> {
    const answer = body.answer;
    const username = body.username;
    if (username === undefined || username === null) {
        await sendClientError(event, connectionId, 'Username is required.', { action: 'SUBMIT_ANSWER' });
        return;
    }

    // check if the game is in the question state
    const session = await getOrCreateSession();
    if (session.state !== 'QUESTION' || !session.roundData) {
        await sendClientError(event, connectionId, 'Game is not in Question state.', { action: 'SUBMIT_ANSWER' });
        return;
    }

    // check if the answer has already been submitted - shouldn't happen but just in case
    const { answersSubmitted } = session.roundData;
    const alreadySubmitted = answersSubmitted.some((a) => a.username === username);
    if (alreadySubmitted) {
        await sendClientError(event, connectionId, 'Answer already submitted.', { action: 'SUBMIT_ANSWER' });
        return;
    }

    answersSubmitted.push({ username, answer: answer ?? '' });
    await saveSession(session);
    await sendToConnection(event, connectionId, { type: 'ANSWER_CONFIRMED' });

    // if all answers have been submitted, we can move to the voting state
    // need to pass correct question and answers submitted for users to display voting screen
    if (answersSubmitted.length === session.users.length) {
        session.state = 'VOTING';
        await saveSession(session);
        const payload = {
            type: 'ROUND_UPDATE',
            state: 'VOTING',
            data: {
                correctQuestion: session.roundData.correctQuestion.question,
                answersSubmitted,
            },
        };
        await Promise.all(session.users.map((user) => sendToConnection(event, user.connectionId, payload)));
    }
}

async function handleVote(connectionId: string, body: any, event: WsHandlerEvent): Promise<void> {
    const target = body.target;
    const username = body.username;
    if (username === undefined || username === null) {
        await sendClientError(event, connectionId, 'Username is required.', { action: 'VOTE' });
        return;
    }

    // check if the game is in the voting state
    const session = await getOrCreateSession();
    if (session.state !== 'VOTING' || !session.roundData) {
        await sendClientError(event, connectionId, 'Game is not in Voting state.', { action: 'VOTE' });
        return;
    }

    // check if the answer has already been submitted - shouldn't happen but just in case
    const { votes } = session.roundData;
    const alreadySubmitted = votes.some((a) => a.username === username);
    if (alreadySubmitted) {
        await sendClientError(event, connectionId, 'Vote already submitted.', { action: 'VOTE' });
        return;
    }

    votes.push({ username, target: target ?? '' });
    await saveSession(session);
    await sendToConnection(event, connectionId, { type: 'VOTE_CONFIRMED' });

    if (votes.length !== session.users.length) {
        return;
    }

    // calculate if the imposter was caught
    // if the imposter was caught, award points to all users who voted for the imposter
    const imposterUsername = session.roundData.imposterUsername;
    const votesForImposter = votes.filter((v) => v.target === imposterUsername).length;
    const majorityCaught = votesForImposter > session.users.length / 2;

    if (majorityCaught) {
        for (const user of session.users) {
            if (user.username !== imposterUsername) user.score += 1;
        }
    } else {
        const imposter = session.users.find((u) => u.username === imposterUsername);
        if (imposter) imposter.score += 1;
    }

    session.state = 'RESULT';
    await saveSession(session);

    // return round update so lobby scores can be updated as well
    const payload = {
        type: 'ROUND_UPDATE',
        state: 'RESULT',
        data: {
            imposterUsername,
            success: majorityCaught,
            updatedScores: session.users.map((u) => ({ username: u.username, score: u.score })),
        },
    };
    await Promise.all(session.users.map((user) => sendToConnection(event, user.connectionId, payload)));
}

async function handleReturnToLobby(connectionId: string, body: any, event: WsHandlerEvent): Promise<void> {
    // force is in case a user disconnects mid-round and we want to return to lobby to restart
    const force = body.force ?? false;
    const session = await getOrCreateSession();
    if (session.state === 'LOBBY') {
        // Already in lobby; just re-broadcast in case someone has stale view
        await broadcastLobbyUpdate(event, session);
        return;
    }

    // return to lobby may also be called after a round has ended.
    if (session.state !== 'RESULT' && !force) {
        await sendClientError(event, connectionId, 'Game is not in Result state. Use force to abort mid-round.', {
            action: 'RETURN_TO_LOBBY',
        });
        return;
    }

    session.state = 'LOBBY';
    session.roundData = null; // clear previous round
    await saveSession(session);

    await broadcastLobbyUpdate(event, session);
}

async function handleJoinSession(connectionId: string, body: any, event: WsHandlerEvent): Promise<void> {
    const username = body.username ?? body.playerName;
    // if username is given
    if (!username) {
        await sendClientError(event, connectionId, 'Username is required.', { action: 'JOIN_SESSION' });
        return;
    }

    // grab session info
    const session = await getOrCreateSession();

    // if the game is not in the lobby, we can't join — unless this username is already in the session (reconnect mid-round)
    if (session.state !== 'LOBBY') {
        const userInSession = session.users.some((u) => u.username === username);
        if (!userInSession) {
            await sendClientError(event, connectionId, 'Game is in progress. Wait for the lobby.', {
                action: 'JOIN_SESSION',
            });
            return;
        }

        // handle username conflicts, or user rejoining (same logic as lobby, but no new players mid-game)
        const resolution = await resolveUsernameConflict(session, username, connectionId, event);
        if (resolution.action === 'reject') {
            await sendClientError(event, connectionId, 'Username is already taken.', { action: 'JOIN_SESSION' });
            return;
        }
        if (resolution.action === 'add') {
            await sendClientError(event, connectionId, 'Cannot join a round in progress.', { action: 'JOIN_SESSION' });
            return;
        }

        // if the user is reconnecting, we can update the connectionId for the user
        if (resolution.action === 'reconnect') {
            const existing = session.users.find((u) => u.username === username);
            if (existing) existing.connectionId = connectionId;
            // saves the user/update to the game session
            await saveSession(session);
        }

        await ddb.send(
            new UpdateItemCommand({
                TableName: process.env.CONNECTIONS_TABLE!,
                Key: { connectionId: { S: connectionId } },
                UpdateExpression: 'SET username = :u, sessionId = :s',
                ExpressionAttributeValues: {
                    ':u': { S: username },
                    ':s': { S: SESSION_ID },
                },
            }),
        );

        const joiningUser = session.users.find((u) => u.username === username);
        if (!joiningUser) {
            await sendClientError(event, connectionId, 'Could not resolve player after reconnect.', {
                action: 'JOIN_SESSION',
            });
            return;
        }
        await sendToConnection(event, connectionId, {
            type: 'JOIN_CONFIRMED',
            username: joiningUser.username,
            color: joiningUser.color,
            score: joiningUser.score,
        });

        await sendSessionCatchUp(event, connectionId, session, username);
        return;
    }

    // handle username conflicts, or user rejoining
    const resolution = await resolveUsernameConflict(session, username, connectionId, event);
    if (resolution.action === 'reject') {
        await sendClientError(event, connectionId, 'Username is already taken.', { action: 'JOIN_SESSION' });
        return;
    }

    // if the user is new, we can add them to the session
    // if the user is reconnecting, we can update the connectionId for the user
    if (resolution.action === 'add') {
        const color = pickAvailableColor(session.users);
        session.users.push({ username, color, score: 0, connectionId });
    } else if (resolution.action === 'reconnect') {
        const existing = session.users.find((u) => u.username === username);
        if (existing) existing.connectionId = connectionId;
    }

    ensureAdminForSession(session);

    // saves the user/update to the game session
    await saveSession(session);

    await ddb.send(
        new UpdateItemCommand({
            TableName: process.env.CONNECTIONS_TABLE!,
            Key: { connectionId: { S: connectionId } },
            UpdateExpression: 'SET username = :u, sessionId = :s',
            ExpressionAttributeValues: {
                ':u': { S: username },
                ':s': { S: SESSION_ID },
            },
        }),
    );

    const joiningUser = session.users.find((u) => u.username === username);
    if (!joiningUser) {
        await sendClientError(event, connectionId, 'Could not resolve player after join.', { action: 'JOIN_SESSION' });
        return;
    }
    await sendToConnection(event, connectionId, {
        type: 'JOIN_CONFIRMED',
        username: joiningUser.username,
        color: joiningUser.color,
        score: joiningUser.score,
    });

    await broadcastLobbyUpdate(event, session);
}

async function handleCode(connectionId: string, body: any, event: WsHandlerEvent): Promise<void> {
    const session = await getOrCreateSession();
    if (session.state !== 'LOBBY') {
        await sendClientError(event, connectionId, 'Codes only work in the lobby.', { action: 'CODE' });
        return;
    }

    const raw = String(body.text ?? '').trim();
    if (!raw) {
        await sendClientError(event, connectionId, 'Empty code.', { action: 'CODE' });
        return;
    }
    const lower = raw.toLowerCase();

    if (lower === 'safe') {
        session.safeMode = true;
        await saveSession(session);
        await broadcastLobbyUpdate(event, session);
        await sendToConnection(event, connectionId, {
            type: 'CODE_OK',
            message: 'Safe mode on (questions with safe=false are excluded).',
        });
        return;
    }

    if (lower === 'unsafe') {
        session.safeMode = false;
        await saveSession(session);
        await broadcastLobbyUpdate(event, session);
        await sendToConnection(event, connectionId, { type: 'CODE_OK', message: 'Safe mode off.' });
        return;
    }

    if (lower.startsWith('kick-')) {
        const targetName = raw.replace(/^kick-/i, '').trim();
        if (!targetName) {
            await sendClientError(event, connectionId, 'Invalid kick format. Use kick-username', {
                action: 'CODE',
            });
            return;
        }
        const target = session.users.find((u) => u.username.toLowerCase() === targetName.toLowerCase());
        if (!target) {
            await sendClientError(event, connectionId, `Player "${targetName}" not in lobby.`, { action: 'CODE' });
            return;
        }
        if (target.connectionId === connectionId) {
            await sendClientError(event, connectionId, "You can't kick yourself.", { action: 'CODE' });
            return;
        }
        await forceDisconnectConnection(event, target.connectionId);
        session.users = session.users.filter((u) => u.connectionId !== target.connectionId);
        ensureAdminForSession(session);
        await saveSession(session);
        await broadcastLobbyUpdate(event, session);
        await sendToConnection(event, connectionId, {
            type: 'CODE_OK',
            message: `Removed ${target.username} from the lobby.`,
        });
        return;
    }

    if (lower.startsWith('admin-')) {
        const targetName = raw.replace(/^admin-/i, '').trim();
        if (!targetName) {
            await sendClientError(event, connectionId, 'Invalid format. Use admin-username', { action: 'CODE' });
            return;
        }
        const target = session.users.find((u) => u.username.toLowerCase() === targetName.toLowerCase());
        if (!target) {
            await sendClientError(event, connectionId, `Player "${targetName}" not in lobby.`, { action: 'CODE' });
            return;
        }
        session.adminUsername = target.username;
        await saveSession(session);
        await broadcastLobbyUpdate(event, session);
        await sendToConnection(event, connectionId, {
            type: 'CODE_OK',
            message: `${target.username} is now lobby admin.`,
        });
        return;
    }

    await sendClientError(event, connectionId, 'Unknown code.', { action: 'CODE' });
}

async function handleLeaveSession(connectionId: string, _body: any, event: WsHandlerEvent): Promise<void> {
    const session = await getOrCreateSession();
    if (session.state !== 'LOBBY') {
        await sendClientError(
            event,
            connectionId,
            'You can only disconnect from the lobby. Use Return to Lobby if you are mid-round.',
            { action: 'LEAVE_SESSION' },
        );
        return;
    }
    const idx = session.users.findIndex((u) => u.connectionId === connectionId);
    if (idx === -1) {
        await sendClientError(event, connectionId, 'Not in this game session.', { action: 'LEAVE_SESSION' });
        return;
    }
    session.users.splice(idx, 1);
    ensureAdminForSession(session);
    await saveSession(session);
    await broadcastLobbyUpdate(event, session);
    await sendToConnection(event, connectionId, { type: 'LEFT_SESSION' });
    await forceDisconnectConnection(event, connectionId);
}

async function handleEndGame(connectionId: string, _body: any, event: WsHandlerEvent): Promise<void> {
    const session = await getOrCreateSession();

    const requester = getUsernameForConnection(session, connectionId);
    if (!requester || requester !== session.adminUsername) {
        await sendClientError(event, connectionId, 'Only the lobby admin can end the game.', {
            action: 'END_GAME',
        });
        return;
    }

    await Promise.all(session.users.map((user) => sendToConnection(event, user.connectionId, { type: 'GAME_ENDED' })));

    applySessionWipe(session);
    await saveSession(session);
}

// ── Main Handler ──
export const handler = async (event: WsHandlerEvent) => {
    const routeKey = event.requestContext.routeKey;
    const connectionId = event.requestContext.connectionId;
    switch (routeKey) {
        case '$connect':
            wsLog(event, { phase: 'connect', ok: true });
            try {
                await ddb.send(
                    new PutItemCommand({
                        TableName: process.env.CONNECTIONS_TABLE!,
                        Item: { connectionId: { S: connectionId } },
                    }),
                );
                wsLog(event, { phase: 'connect_complete', ok: true, connectionsRowWritten: true });
            } catch (err: any) {
                wsLog(event, {
                    phase: 'connect_complete',
                    ok: false,
                    error: err?.message ?? String(err),
                    name: err?.name,
                });
                console.error('Error saving connection:', err);
                return { statusCode: 500, body: 'Failed to connect' };
            }
            return { statusCode: 200, body: 'Connected.' };
        case '$disconnect':
            wsLog(event, { phase: 'disconnect', ok: true });
            // NOTE: Per-disconnect we delete the connection then may scan session + GetItem each player.
            // Fine for a small friends app; optimize if you add many concurrent rooms or large lobbies.
            // try {
            //     await removeLobbyUserOnDisconnect(connectionId, event);
            // } catch (err) {
            //     console.error('removeLobbyUserOnDisconnect:', err);
            // }
            try {
                await ddb.send(
                    new DeleteItemCommand({
                        TableName: process.env.CONNECTIONS_TABLE!,
                        Key: { connectionId: { S: connectionId } },
                    }),
                );
                wsLog(event, { phase: 'disconnect_complete', ok: true, connectionsRowDeleted: true });
            } catch (err: any) {
                wsLog(event, {
                    phase: 'disconnect_complete',
                    ok: false,
                    error: err?.message ?? String(err),
                    name: err?.name,
                });
                throw err;
            }
            /* Not using this for now, but leaving it here for future reference
            try {
                await abandonSessionIfEveryoneDisconnected();
            } catch (err) {
                console.error('abandonSessionIfEveryoneDisconnected:', err);
            }
            */
            return { statusCode: 200, body: 'Disconnected.' };
        default: {
            event.imposterInvokeMeta = { clientErrorSent: false };
            let body: any;
            try {
                body = JSON.parse(event.body ?? '{}');
            } catch {
                wsLog(event, {
                    phase: 'request',
                    parseError: true,
                    rawBodyPreview: String(event.body ?? '').slice(0, 200),
                });
                await sendClientError(event, connectionId, 'Invalid JSON.', { action: undefined });
                wsLog(event, {
                    phase: 'request_complete',
                    action: null,
                    lambdaOk: true,
                    clientSuccess: false,
                });
                return { statusCode: 400, body: 'Invalid JSON' };
            }
            const action = body.action;
            wsLog(event, { phase: 'request', action, payload: body });
            try {
                switch (action) {
                    case 'JOIN_SESSION':
                        await handleJoinSession(connectionId, body, event);
                        break;
                    case 'START_ROUND':
                        await handleStartRound(connectionId, body, event);
                        break;
                    case 'SUBMIT_ANSWER':
                        await handleSubmitAnswer(connectionId, body, event);
                        break;
                    case 'VOTE':
                        await handleVote(connectionId, body, event);
                        break;
                    case 'RETURN_TO_LOBBY':
                        await handleReturnToLobby(connectionId, body, event);
                        break;
                    case 'END_GAME':
                        await handleEndGame(connectionId, body, event);
                        break;
                    case 'LEAVE_SESSION':
                        await handleLeaveSession(connectionId, body, event);
                        break;
                    case 'CODE':
                        await handleCode(connectionId, body, event);
                        break;
                    default:
                        await sendClientError(event, connectionId, `Unknown action: ${action}`, {
                            action: action ?? 'unknown',
                        });
                }
            } catch (err: any) {
                wsLog(event, {
                    phase: 'request_error',
                    action,
                    lambdaOk: false,
                    error: err?.message ?? String(err),
                    name: err?.name,
                });
                throw err;
            }
            const meta = event.imposterInvokeMeta ?? { clientErrorSent: false };
            wsLog(event, {
                phase: 'request_complete',
                action,
                lambdaOk: true,
                clientSuccess: !meta.clientErrorSent,
            });
            return { statusCode: 200, body: 'OK' };
        }
    }
};
