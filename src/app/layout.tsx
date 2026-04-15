import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Phil",
  description: "Voice + chat coaching for AIAI Mastermind insurance agents",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
