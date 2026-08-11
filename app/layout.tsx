import type { Metadata, Viewport } from "next";
import "./globals.css";
import { siteConfiguration } from "./site-config";

const siteUrl = new URL(siteConfiguration.siteUrl);
const faviconUrl = new URL("favicon.svg", siteUrl).toString();
const socialImageUrl = new URL("og.png", siteUrl).toString();

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: "#f4f0e5",
};

export const metadata: Metadata = {
  metadataBase: siteUrl,
  applicationName: "睿安成 PICKLE CLUB",
  title: "睿安成 PICKLE CLUB｜南昌匹克球预约",
  description:
    "了解睿安成 Pickle Club 的场地与教练，在线查询场次并提交预约。",
  referrer: "strict-origin-when-cross-origin",
  formatDetection: {
    address: false,
    email: false,
    telephone: false,
  },
  icons: {
    icon: faviconUrl,
    shortcut: faviconUrl,
  },
  alternates: {
    canonical: siteConfiguration.siteUrl,
  },
  openGraph: {
    type: "website",
    url: siteConfiguration.siteUrl,
    locale: "zh_CN",
    siteName: "睿安成 PICKLE CLUB",
    title: "睿安成 PICKLE CLUB",
    description: "南昌匹克球场地与在线预约",
    images: [
      {
        url: socialImageUrl,
        width: 1672,
        height: 941,
        alt: "睿安成 PICKLE CLUB 南昌匹克球",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "睿安成 PICKLE CLUB",
    description: "南昌匹克球场地与在线预约",
    images: [
      {
        url: socialImageUrl,
        alt: "睿安成 PICKLE CLUB 南昌匹克球",
      },
    ],
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
