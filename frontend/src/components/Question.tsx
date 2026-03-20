'use client';

import { useState, FormEvent } from 'react';
import { motion } from 'framer-motion';
import { useWebSocket } from '../lib/WebSocketContext';
import SendIcon from '@mui/icons-material/Send';

export default function Question() {
    const { gameState, sendMessage, username } = useWebSocket();
    const [answer, setAnswer] = useState('');
    const submitted = gameState.answerConfirmed;

    const handleSubmit = (e: FormEvent) => {
        e.preventDefault();
        if (submitted) return;
        sendMessage('SUBMIT_ANSWER', { username, answer });
    };

    const handleReturnToLobby = () => sendMessage('RETURN_TO_LOBBY', { force: true });

    return (
        <div className="flex flex-col h-full p-4 max-w-lg mx-auto">
            <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex-1 flex flex-col items-center justify-center"
            >
                <p className="text-gray-400 text-sm mb-2 uppercase tracking-wider">Your Question</p>
                <h2 className="text-2xl font-bold text-center mb-8 px-4">{gameState.question}</h2>

                <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
                    <input
                        type="text"
                        value={answer}
                        onChange={(e) => setAnswer(e.target.value)}
                        placeholder="Your answer..."
                        disabled={submitted}
                        autoFocus
                        className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-xl
                                   focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
                                   placeholder-gray-500 text-lg disabled:opacity-50"
                    />

                    {!submitted ? (
                        <motion.button
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            type="submit"
                            className="w-full py-3 bg-blue-600 hover:bg-blue-500 rounded-xl text-lg
                                       font-semibold transition-colors flex items-center justify-center gap-2"
                        >
                            Submit Answer
                            <SendIcon fontSize="small" />
                        </motion.button>
                    ) : (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="text-center py-3"
                        >
                            <div className="inline-flex items-center gap-2 text-green-400 mb-2">
                                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                                    <path
                                        fillRule="evenodd"
                                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                        clipRule="evenodd"
                                    />
                                </svg>
                                Answer submitted!
                            </div>
                            <p className="text-gray-400 text-sm">Waiting for other players...</p>
                            <motion.div
                                className="mt-3 h-1 w-16 mx-auto bg-gray-700 rounded-full overflow-hidden"
                            >
                                <motion.div
                                    className="h-full bg-blue-500 rounded-full"
                                    animate={{ x: ['-100%', '100%'] }}
                                    transition={{ repeat: Infinity, duration: 1.5, ease: 'easeInOut' }}
                                    style={{ width: '50%' }}
                                />
                            </motion.div>
                        </motion.div>
                    )}
                </form>
            </motion.div>

            <button
                onClick={handleReturnToLobby}
                className="mt-4 py-2 text-gray-500 hover:text-gray-300 text-sm transition-colors text-center"
            >
                Return to Lobby
            </button>
        </div>
    );
}
