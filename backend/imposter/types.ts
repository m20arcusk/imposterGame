import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';

/** Single-room game phases stored on the session. */
export type GamePhase = 'LOBBY' | 'QUESTION' | 'VOTING' | 'RESULT';

export interface SessionUser {
    username: string;
    color: string;
    score: number;
    connectionId: string;
    sessionToken?: string;
}

export interface RoundData {
    correctQuestion: { questionId: string; question: string };
    imposterQuestion: { questionId: string; question: string };
    imposterUsername: string;
    answersSubmitted: { username: string; answer: string }[];
    votes: { username: string; target: string }[];
}

/** In-memory + DynamoDB shape for the default session row. */
export interface GameSession {
    sessionId: string;
    state: GamePhase;
    users: SessionUser[];
    roundData: RoundData | null;
    usedQuestionIds: string[];
    excludedRanges: string[];
    safeMode: boolean;
    adminUsername: string | null;
}

/** Tracks whether we already sent a client-visible ERROR (for `request_complete.clientSuccess`). */
export type InvokeMeta = { clientErrorSent: boolean };

export type QuestionPick = {
    correct: { questionId: string; question: string };
    imposter: { questionId: string; question: string };
};

export type UsernameConflictAction = 'reject' | 'add' | 'reconnect' | 'idempotent';

/** API Gateway WebSocket Lambda event with optional per-invocation flags. */
export type WsHandlerEvent = APIGatewayProxyWebsocketEventV2 & {
    imposterInvokeMeta?: InvokeMeta;
};
