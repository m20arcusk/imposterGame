'use client';

import { useState, useEffect, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import SendIcon from '@mui/icons-material/Send';

export default function LoginPage() {
    const [input, setInput] = useState('');
    const [error, setError] = useState<string | null>(null);
    const router = useRouter();

    useEffect(() => {
        const joinError = sessionStorage.getItem('imposter_join_error');
        if (joinError) {
            setError(joinError);
            sessionStorage.removeItem('imposter_join_error');
        }
    }, []);

    const handleSubmit = (e: FormEvent) => {
        e.preventDefault();
        const username = input.trim();
        if (!username) return;
        setError(null);
        localStorage.setItem('imposter_username', username);
        router.push('/game');
    };

    return (
        <div className="min-h-dvh flex items-center justify-center p-4">
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4 }}
                className="w-full max-w-sm"
            >
                <div className="bg-gray-900 rounded-2xl p-8 shadow-xl border border-gray-800">
                    <h1 className="text-3xl font-bold text-center mb-2">Imposter Game</h1>
                    <p className="text-gray-400 text-center mb-8 text-sm">Enter a username to join</p>

                    {error && (
                        <motion.div
                            initial={{ opacity: 0, y: -10 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-2 text-sm rounded-xl mb-4 text-center"
                        >
                            {error}
                        </motion.div>
                    )}

                    <form onSubmit={handleSubmit} className="space-y-4">
                        <input
                            type="text"
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            placeholder="Username"
                            maxLength={20}
                            autoFocus
                            className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-xl
                                       focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
                                       placeholder-gray-500 text-lg"
                        />

                        <motion.button
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            type="submit"
                            disabled={!input.trim()}
                            className="w-full py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700
                                       disabled:text-gray-500 rounded-xl text-lg font-semibold
                                       transition-colors flex items-center justify-center gap-2"
                        >
                            Join Game
                            <SendIcon fontSize="small" />
                        </motion.button>
                    </form>
                </div>
            </motion.div>
        </div>
    );
}
