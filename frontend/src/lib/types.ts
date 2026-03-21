export type User = {
    username: string;
    color: string;
    score: number;
};

export type Answer = {
    username: string;
    answer: string;
};

export type RoundResult = {
    imposterUsername: string;
    success: boolean;
    updatedScores: { username: string; score: number }[];
};

export type GamePhase = 'LOBBY' | 'QUESTION' | 'VOTING' | 'RESULT';

export type GameState = {
    phase: GamePhase;
    users: User[];
    question?: string;
    answers?: Answer[];
    correctQuestion?: string;
    result?: RoundResult;
    answerConfirmed?: boolean;
    voteConfirmed?: boolean;
    gameEnded?: boolean;
    /** When true, server excludes questions with safe=false */
    safeMode?: boolean;
    /** Last successful lobby CODE command feedback */
    codeAck?: string;
};

export type ServerMessage =
    | { type: 'LOBBY_UPDATE'; data: User[]; safeMode?: boolean }
    | { type: 'JOIN_CONFIRMED'; username: string; color: string; score: number }
    | { type: 'QUESTION_ASSIGNMENT'; question: string }
    | { type: 'ROUND_UPDATE'; state: 'VOTING'; data: { correctQuestion: string; answersSubmitted: Answer[] } }
    | { type: 'ROUND_UPDATE'; state: 'RESULT'; data: RoundResult }
    | { type: 'ANSWER_CONFIRMED' }
    | { type: 'VOTE_CONFIRMED' }
    | { type: 'GAME_ENDED' }
    | { type: 'LEFT_SESSION' }
    | { type: 'CODE_OK'; message: string }
    | { type: 'ERROR'; message: string };
