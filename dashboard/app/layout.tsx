import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import Sidebar from "@/components/sidebar";
import Navbar from "@/components/navbar";

export const metadata: Metadata = {
    title: "OpenMemory Dashboard",
    description: "Memory analytics and monitoring dashboard",
    icons: {
        icon: '/favicon.ico',
    },
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en">
            <body
                className={`${GeistSans.variable} ${GeistMono.variable} antialiased bg-black text-stone-300`}
                suppressHydrationWarning
            >
                <Sidebar />
                <Navbar />
                <main className="ml-20 mt-20 p-4 min-h-screen transition-all duration-300">
                    {children}
                </main>
            </body>
        </html>
    );
}
