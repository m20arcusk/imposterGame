import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
    title: 'Imposter Game',
    description: 'Find the imposter among your friends!',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en">
            <body className="bg-gray-950 text-white min-h-dvh antialiased">{children}</body>
        </html>
    );
}
