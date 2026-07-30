import type { Metadata } from "next";
import "./globals.css";

const defaultSiteUrl =
  "https://chengchang-pickle-club.hujingseuits.chatgpt.site/";
const siteUrl = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? defaultSiteUrl);
const faviconUrl = new URL("favicon.svg", siteUrl).toString();
const socialImageUrl = new URL("og.png", siteUrl).toString();

export const metadata: Metadata = {
  metadataBase: siteUrl,
  title: "澄场 PICKLE CLUB｜城市匹克球体验空间",
  description:
    "认识匹克球、了解澄场的场地与团队，并完成一次预约体验演示。",
  icons: {
    icon: faviconUrl,
    shortcut: faviconUrl,
  },
  openGraph: {
    type: "website",
    locale: "zh_CN",
    title: "澄场 PICKLE CLUB",
    description: "为城市留一块会呼吸的球场",
    images: [{ url: socialImageUrl }],
  },
  twitter: {
    card: "summary_large_image",
    title: "澄场 PICKLE CLUB",
    description: "为城市留一块会呼吸的球场",
    images: [socialImageUrl],
  },
};

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
