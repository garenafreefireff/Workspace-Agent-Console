import "./globals.css";

export const metadata = {
  title: "Local Agent GUI",
  description: "Visual dashboard for the local workspace MCP server.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
