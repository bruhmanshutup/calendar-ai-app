import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono, Instrument_Serif, Inter, Space_Grotesk } from "next/font/google";
import { PlanPilotProvider } from "./components/planpilot-provider";
import "./globals.css";
// "Studio" look for the signed-in app. Delete this line (and studio-look.css) to remove it entirely.
import "./studio-look.css";

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

// Studio look fonts: Inter for interface text, Instrument Serif italic for one accent word per heading.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
  style: "italic",
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
        {/* Apply the saved app look ("studio" by default, or "classic") before first paint. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{document.documentElement.dataset.look=localStorage.getItem('planpilot-look')==='classic'?'classic':'studio'}catch(e){document.documentElement.dataset.look='studio'}",
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${spaceGrotesk.variable} ${inter.variable} ${instrumentSerif.variable} antialiased`}
      >
        <PlanPilotProvider>{children}</PlanPilotProvider>
      </body>
    </html>
  );
}
