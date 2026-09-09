import "./globals.css";
import { Providers } from "./providers";

export const metadata = {
  title: "IDX Smart Money Decision Engine",
  description: "Operational dashboard for IDX broker-flow decision support"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
