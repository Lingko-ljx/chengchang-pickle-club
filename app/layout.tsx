import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost:3001";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const baseUrl = new URL(`${protocol}://${host}`);
  const socialImage = new URL("/og.png", baseUrl).toString();

  return {
    metadataBase: baseUrl,
    title: "澄场 PICKLE CLUB｜城市匹克球体验空间",
    description:
      "认识匹克球、了解澄场的场地与团队，并完成一次预约体验演示。",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      type: "website",
      locale: "zh_CN",
      title: "澄场 PICKLE CLUB",
      description: "为城市留一块会呼吸的球场",
      images: [{ url: socialImage }],
    },
    twitter: {
      card: "summary_large_image",
      title: "澄场 PICKLE CLUB",
      description: "为城市留一块会呼吸的球场",
      images: [socialImage],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
