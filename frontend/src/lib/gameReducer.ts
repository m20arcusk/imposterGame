import { GameState, ServerMessage } from './types';

export const initialGameState: GameState = {
    phase: 'LOBBY',
    users: [],
};

export function gameReducer(state: GameState, message: ServerMessage): GameState {
    switch (message.type) {
        case 'LOBBY_UPDATE':
            return {
                ...state,
                phase: 'LOBBY',
                users: message.data,
                question: undefined,
                answers: undefined,
                correctQuestion: undefined,
                result: undefined,
                answerConfirmed: false,
                voteConfirmed: false,
            };

        case 'QUESTION_ASSIGNMENT':
            return {
                ...state,
                phase: 'QUESTION',
                question: message.question,
                answerConfirmed: false,
            };

        case 'ROUND_UPDATE':
            if (message.state === 'VOTING') {
                return {
                    ...state,
                    phase: 'VOTING',
                    correctQuestion: message.data.correctQuestion,
                    answers: message.data.answersSubmitted,
                    voteConfirmed: false,
                };
            }
            if (message.state === 'RESULT') {
                return {
                    ...state,
                    phase: 'RESULT',
                    result: message.data,
                    users: state.users.map((u) => {
                        const updated = message.data.updatedScores.find((s) => s.username === u.username);
                        return updated ? { ...u, score: updated.score } : u;
                    }),
                };
            }
            return state;

        case 'JOIN_CONFIRMED':
            return { ...state, phase: 'LOBBY' };

        case 'ANSWER_CONFIRMED':
            return { ...state, answerConfirmed: true };

        case 'VOTE_CONFIRMED':
            return { ...state, voteConfirmed: true };

        case 'GAME_ENDED':
            return { ...initialGameState, gameEnded: true };

        case 'ERROR':
            return state;

        default:
            return state;
    }
}
