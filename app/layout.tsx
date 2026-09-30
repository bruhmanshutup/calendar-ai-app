import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono, Space_Grotesk } from "next/font/google";
import { PlanPilotProvider } from "./components/planpilot-provider";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

// Display face for headlines and big numbers.
const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host?.includes("localhost") ? "http" : "https");
  const base = host ? `${protocol}://${host}` : "http://localhost:3000";
  return {
    metadataBase: new URL(base),
    title: {
      default: "PlanPilot — realistic planning that explains itself",
      template: "%s · PlanPilot",
    },
    description:
      "Turn messy responsibilities into a realistic, explainable, adjustable schedule.",
    openGraph: {
      title: "PlanPilot — plan with reality",
      description:
        "Extract tasks, review uncertainty, protect buffer, and recover from missed work without rebuilding the week.",
      type: "website",
      images: [
        {
          url: "/og-overdue.png",
          width: 1200,
          height: 630,
          alt: "PlanPilot — Plan with reality.",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "PlanPilot — plan with reality",
      description:
        "A realistic planning layer for messy responsibilities.",
      images: ["/og-overdue.png"],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Apply the saved theme before first paint to avoid a light flash. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{if(localStorage.getItem('planpilot-theme')!=='light'){document.documentElement.classList.add('dark')}}catch(e){document.documentElement.classList.add('dark')}",
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${spaceGrotesk.variable} antialiased`}
      >
        <PlanPilotProvider>{children}</PlanPilotProvider>
      </body>
    </html>
  );
}
