import { Loader2 } from "lucide-react";

interface PageLoaderProps {
  message?: string;
}

export const PageLoader = ({ message }: PageLoaderProps = {}) => (
  <div className="flex h-screen w-full flex-col items-center justify-center bg-background gap-4">
    <Loader2 className="h-8 w-8 animate-spin text-primary" />
    {message && <p className="text-muted-foreground text-sm">{message}</p>}
  </div>
);
