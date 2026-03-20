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

function pickAvailableColor(users: { color: string }[]): string {
    const used = new Set(users.map((u) => u.color));
    const free = COLORS.find((c) => !used.has(c));
    if (free) return free;
    return COLORS[users.length % COLORS.length];
}

// ── Helpers ──
// This is a helper function to get the APIGW client
// which is used to send messages to the users
const getApigwClient = (event: any) => {
    const domain = event.requestContext.domainName;
    const stage = event.requestContext.stage;
    return new ApiGatewayManagementApiClient({
        endpoint: `https://${domain}/${stage}`,
    });
};

async function getOrCreateSession(): Promise<any> {
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
            state: result.Item.state?.S ?? 'LOBBY',
            users: JSON.parse(result.Item.users?.S ?? '[]'),
            roundData: result.Item.roundData?.S ? JSON.parse(result.Item.roundData.S) : null,
            usedQuestionIds: JSON.parse(result.Item.usedQuestionIds?.S ?? '[]'),
            excludedRanges: JSON.parse(result.Item.excludedRanges?.S ?? '[]'),
            safeMode: result.Item.safeMode?.BOOL === true,
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
    };
}

// This is a helper function to save the session to the database
async function saveSession(session: any): Promise<void> {
    const item: Record<string, any> = {
        sessionId: { S: session.sessionId },
        state: { S: session.state },
        users: { S: JSON.stringify(session.users) },
        usedQuestionIds: { S: JSON.stringify(session.usedQuestionIds ?? []) },
        excludedRanges: { S: JSON.stringify(session.excludedRanges ?? []) },
        safeMode: { BOOL: session.safeMode === true },
    };
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
    session: any,
    username: string,
    connectionId: string,
): Promise<{ action: 'reject' | 'add' | 'reconnect' | 'idempotent' }> {
    const existing = session.users.find((u: any) => u.username === username);
    // if the user is not found, we can add them to the session
    if (!existing) return { action: 'add' }; // New user
    // if the user is found, and the connectionId is the same, we can return that the user is already in
    if (existing.connectionId === connectionId) return { action: 'idempotent' }; 
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
    // if the old connection is still active, we can reject the new connection
    // if the old connection is not active, we can reconnect the user
    return oldConnActive ? { action: 'reject' } : { action: 'reconnect' };
}

// this is how we send information to the users
/** Close a WebSocket and remove its Connections row (kick / admin). */
async function forceDisconnectConnection(event: any, connectionId: string): Promise<void> {
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

async function sendToConnection(event: any, connectionId: string, payload: any): Promise<void> {
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
            console.log(`Stale connection ${connectionId}`);
        } else {
            throw err;
        }
    }
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
): Promise<{
    correct: { questionId: string; question: string };
    imposter: { questionId: string; question: string };
}> {
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

type QuestionPick = {
    correct: { questionId: string; question: string };
    imposter: { questionId: string; question: string };
};

/** Reset in-memory session to empty lobby (caller must saveSession). */
function applySessionWipe(session: any): void {
    session.state = 'LOBBY';
    session.roundData = null;
    session.users = [];
    session.usedQuestionIds = [];
    session.excludedRanges = [];
    session.safeMode = false;
}

/**
 * If no registered player still has a row in Connections, clear the game session.
 * Does not send GAME_ENDED (no clients to reach). Call after removing the disconnecting connection.
 *
 * NOTE: This does O(players) GetItem calls per disconnect. If you scale to many rooms/users,
 * consider a GSI on sessionId, connection TTL, or a single "active count" counter instead.
 */
async function abandonSessionIfEveryoneDisconnected(): Promise<void> {
    const session = await getOrCreateSession();
    if (!session.users?.length) return;

    for (const user of session.users) {
        const conn = await ddb.send(
            new GetItemCommand({
                TableName: process.env.CONNECTIONS_TABLE!,
                Key: { connectionId: { S: user.connectionId } },
            }),
        );
        if (conn.Item) return;
    }

    applySessionWipe(session);
    await saveSession(session);
}

async function broadcastLobbyUpdate(event: any, session: any): Promise<void> {
    const payload = {
        type: 'LOBBY_UPDATE',
        data: session.users.map((u: any) => ({ username: u.username, color: u.color, score: u.score })),
        safeMode: session.safeMode === true,
    };
    for (const user of session.users) {
        await sendToConnection(event, user.connectionId, payload);
    }
}

// ── Action Handlers ──
async function handleStartRound(connectionId: string, body: any, event: any): Promise<void> {
    const session = await getOrCreateSession();

    // check if the game is in the lobby
    if (session.state !== 'LOBBY') {
        await sendToConnection(event, connectionId, {
            type: 'ERROR',
            message: 'Round already in progress. Use Return to Lobby first.',
        });
        return;
    }

    // check if there are at least 3 players to start
    if (session.users.length < 3) {
        await sendToConnection(event, connectionId, {
            type: 'ERROR',
            message: 'Need at least 3 players to start.',
        });
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
            for (const user of session.users) {
                await sendToConnection(event, user.connectionId, { type: 'GAME_ENDED' });
            }
            applySessionWipe(session);
            await saveSession(session);
            return;
        }
        await sendToConnection(event, connectionId, {
            type: 'ERROR',
            message: `Failed to select questions: ${err.message}`,
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
    for (const user of session.users) {
        const question =
            user.username === imposterUsername ? questionPair.imposter.question : questionPair.correct.question;
        await sendToConnection(event, user.connectionId, {
            type: 'QUESTION_ASSIGNMENT',
            question,
        });
    }
}

async function handleSubmitAnswer(connectionId: string, body: any, event: any): Promise<void> {
    const answer = body.answer;
    const username = body.username;
    if (username === undefined || username === null) {
        await sendToConnection(event, connectionId, { type: 'ERROR', message: 'Username is required.' });
        return;
    }

    // check if the game is in the question state
    const session = await getOrCreateSession();
    if (session.state !== 'QUESTION' || !session.roundData) {
        await sendToConnection(event, connectionId, { type: 'ERROR', message: 'Game is not in Question state.' });
        return;
    }

    // check if the answer has already been submitted - shouldn't happen but just in case
    const { answersSubmitted } = session.roundData;
    const alreadySubmitted = answersSubmitted.some((a: any) => a.username === username);
    if (alreadySubmitted) {
        await sendToConnection(event, connectionId, { type: 'ERROR', message: 'Answer already submitted.' });
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
        for (const user of session.users) {
            await sendToConnection(event, user.connectionId, payload);
        }
    }
}

async function handleVote(connectionId: string, body: any, event: any): Promise<void> {
    const target = body.target;
    const username = body.username;
    if (username === undefined || username === null) {
        await sendToConnection(event, connectionId, { type: 'ERROR', message: 'Username is required.' });
        return;
    }

    // check if the game is in the voting state
    const session = await getOrCreateSession();
    if (session.state !== 'VOTING' || !session.roundData) {
        await sendToConnection(event, connectionId, { type: 'ERROR', message: 'Game is not in Voting state.' });
        return;
    }

    // check if the answer has already been submitted - shouldn't happen but just in case
    const { votes } = session.roundData;
    const alreadySubmitted = votes.some((a: any) => a.username === username);
    if (alreadySubmitted) {
        await sendToConnection(event, connectionId, { type: 'ERROR', message: 'Vote already submitted.' });
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
    const votesForImposter = votes.filter((v: any) => v.target === imposterUsername).length;
    const majorityCaught = votesForImposter > session.users.length / 2;

    if (majorityCaught) {
        for (const user of session.users) {
            if (user.username !== imposterUsername) user.score += 1;
        }
    } else {
        const imposter = session.users.find((u: any) => u.username === imposterUsername);
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
            updatedScores: session.users.map((u: any) => ({ username: u.username, score: u.score })),
        },
    };
    for (const user of session.users) {
        await sendToConnection(event, user.connectionId, payload);
    }
}

async function handleReturnToLobby(connectionId: string, body: any, event: any): Promise<void> {
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
        await sendToConnection(event, connectionId, {
            type: 'ERROR',
            message: 'Game is not in Result state. Use force to abort mid-round.',
        });
        return;
    }

    session.state = 'LOBBY';
    session.roundData = null; // clear previous round
    await saveSession(session);

    await broadcastLobbyUpdate(event, session);
}

async function handleJoinSession(connectionId: string, body: any, event: any): Promise<void> {
    const username = body.username ?? body.playerName;
    // if username is given
    if (!username) {
        await sendToConnection(event, connectionId, { type: 'ERROR', message: 'Username is required.' });
        return;
    }

    // grab session info
    const session = await getOrCreateSession();

    // if the game is not in the lobby, we can't join
    if (session.state !== 'LOBBY') {
        await sendToConnection(event, connectionId, {
            type: 'ERROR',
            message: 'Game is in progress. Wait for the lobby.',
        });
        return;
    }

    // handle username conflicts, or user rejoining
    const resolution = await resolveUsernameConflict(session, username, connectionId);
    if (resolution.action === 'reject') {
        await sendToConnection(event, connectionId, { type: 'ERROR', message: 'Username is already taken.' });
        return;
    }

    // if the user is new, we can add them to the session
    // if the user is reconnecting, we can update the connectionId for the user
    if (resolution.action === 'add') {
        const color = pickAvailableColor(session.users);
        session.users.push({ username, color, score: 0, connectionId });
    } else if (resolution.action === 'reconnect') {
        const existing = session.users.find((u: any) => u.username === username);
        if (existing) existing.connectionId = connectionId;
    }

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

    const joiningUser = session.users.find((u: any) => u.username === username);
    await sendToConnection(event, connectionId, {
        type: 'JOIN_CONFIRMED',
        username: joiningUser.username,
        color: joiningUser.color,
        score: joiningUser.score,
    });

    await broadcastLobbyUpdate(event, session);
}

async function handleCode(connectionId: string, body: any, event: any): Promise<void> {
    const session = await getOrCreateSession();
    if (session.state !== 'LOBBY') {
        await sendToConnection(event, connectionId, { type: 'ERROR', message: 'Codes only work in the lobby.' });
        return;
    }

    const raw = String(body.text ?? '').trim();
    if (!raw) {
        await sendToConnection(event, connectionId, { type: 'ERROR', message: 'Empty code.' });
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
            await sendToConnection(event, connectionId, {
                type: 'ERROR',
                message: 'Invalid kick format. Use kick-username',
            });
            return;
        }
        const target = session.users.find((u: any) => u.username.toLowerCase() === targetName.toLowerCase());
        if (!target) {
            await sendToConnection(event, connectionId, {
                type: 'ERROR',
                message: `Player "${targetName}" not in lobby.`,
            });
            return;
        }
        if (target.connectionId === connectionId) {
            await sendToConnection(event, connectionId, { type: 'ERROR', message: "You can't kick yourself." });
            return;
        }
        await forceDisconnectConnection(event, target.connectionId);
        session.users = session.users.filter((u: any) => u.connectionId !== target.connectionId);
        await saveSession(session);
        await broadcastLobbyUpdate(event, session);
        await sendToConnection(event, connectionId, {
            type: 'CODE_OK',
            message: `Removed ${target.username} from the lobby.`,
        });
        return;
    }

    await sendToConnection(event, connectionId, { type: 'ERROR', message: 'Unknown code.' });
}

async function handleEndGame(connectionId: string, body: any, event: any): Promise<void> {
    const session = await getOrCreateSession();

    // notify all players before clearing
    for (const user of session.users) {
        await sendToConnection(event, user.connectionId, { type: 'GAME_ENDED' });
    }

    applySessionWipe(session);
    await saveSession(session);
}

// ── Main Handler ──
export const handler = async (event: any) => {
    const routeKey = event.requestContext.routeKey;
    const connectionId = event.requestContext.connectionId;
    switch (routeKey) {
        case '$connect':
            try {
                await ddb.send(
                    new PutItemCommand({
                        TableName: process.env.CONNECTIONS_TABLE!,
                        Item: { connectionId: { S: connectionId } },
                    }),
                );
                console.log(`Connection saved: ${connectionId}`);
            } catch (err) {
                console.error('Error saving connection:', err);
                return { statusCode: 500, body: 'Failed to connect' };
            }
            return { statusCode: 200, body: 'Connected.' };
        case '$disconnect':
            // NOTE: Per-disconnect we delete the connection then may scan session + GetItem each player.
            // Fine for a small friends app; optimize if you add many concurrent rooms or large lobbies.
            await ddb.send(
                new DeleteItemCommand({
                    TableName: process.env.CONNECTIONS_TABLE!,
                    Key: { connectionId: { S: connectionId } },
                }),
            );
            try {
                await abandonSessionIfEveryoneDisconnected();
            } catch (err) {
                console.error('abandonSessionIfEveryoneDisconnected:', err);
            }
            return { statusCode: 200, body: 'Disconnected.' };
        default: {
            let body: any;
            try {
                body = JSON.parse(event.body ?? '{}');
            } catch {
                await sendToConnection(event, connectionId, { type: 'ERROR', message: 'Invalid JSON.' });
                return { statusCode: 400, body: 'Invalid JSON' };
            }
            const action = body.action;
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
                case 'CODE':
                    await handleCode(connectionId, body, event);
                    break;
                default:
                    await sendToConnection(event, connectionId, {
                        type: 'ERROR',
                        message: `Unknown action: ${action}`,
                    });
            }
            return { statusCode: 200, body: 'OK' };
        }
    }
};
