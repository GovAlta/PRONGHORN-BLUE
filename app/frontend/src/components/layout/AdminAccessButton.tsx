import { Badge } from "@/components/ui/badge";
import { ShieldCheck, Crown, Loader2 } from "lucide-react";
import { useAdmin } from "@/contexts/AdminContext";

export function AdminAccessButton() {
  const { isAdmin, isSuperAdmin, loading } = useAdmin();

  if (loading) {
    return (
      <div className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isSuperAdmin) {
    return (
      <Badge variant="default" className="gap-1 bg-purple-600 hover:bg-purple-700">
        <Crown className="h-3 w-3" />
        Superadmin
      </Badge>
    );
  }

  if (isAdmin) {
    return (
      <Badge variant="default" className="gap-1">
        <ShieldCheck className="h-3 w-3" />
        Admin
      </Badge>
    );
  }

  // Non-admin users don't see anything
  return null;
}
