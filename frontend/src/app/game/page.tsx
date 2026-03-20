'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { WebSocketProvider, useWebSocket } from '../../lib/WebSocketContext';
import Lobby from '../../components/Lobby';
import Question from '../../components/Question';
import Voting from '../../components/Voting';
import Results from '../../components/Results';

function GameShell() {
    const { gameState, username, connected, joined } = useWebSocket(); // removed error from here
    const router = useRouter();

    useEffect(() => {
        const stored = typeof window !== 'undefined' ? localStorage.getItem('imposter_username') : null;
        if (!stored) {
            router.push('/');
        }
    }, [router, username]);

    useEffect(() => {
        if (gameState.gameEnded) {
            router.push('/');
        }
    }, [gameState.gameEnded, router]);

    if (!connected || !joined) {
        return (
            <div className="min-h-dvh flex items-center justify-center">
                <div className="text-center">
                    <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full mx-auto mb-4" />
                    <p className="text-gray-400">{connected ? 'Joining game...' : 'Connecting...'}</p>
                </div>
            </div>
        );
    }

    const phaseComponent = () => {
        switch (gameState.phase) {
            case 'LOBBY':
                return <Lobby />;
            case 'QUESTION':
                return <Question />;
            case 'VOTING':
                return <Voting />;
            case 'RESULT':
                return <Results />;
            default:
                return <Lobby />;
        }
    };

    return (
        <div className="min-h-dvh flex flex-col">
            {/* {error && ( 
                <motion.div
                    initial={{ opacity: 0, y: -20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-2 text-sm text-center"
                >
                    {error}
                </motion.div>
            )} */}

            <AnimatePresence mode="wait">
                <motion.div
                    key={gameState.phase}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.25 }}
                    className="flex-1 flex flex-col"
                >
                    {phaseComponent()}
                </motion.div>
            </AnimatePresence>
        </div>
    );
}

export default function GamePage() {
    return (
        <WebSocketProvider>
            <GameShell />
        </WebSocketProvider>
    );
}
