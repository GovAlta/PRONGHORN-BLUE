import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { pronghornApi } from "@/integrations/pronghorn-api/client";
import { useAuth } from "@/contexts/AuthContext";

type AdminRole = "superadmin" | "admin" | "user" | null;

interface AdminContextType {
  isAdmin: boolean;
  isSuperAdmin: boolean;
  role: AdminRole;
  loading: boolean;
  refreshAdminStatus: () => Promise<void>;
}

const AdminContext = createContext<AdminContextType | undefined>(undefined);

export function AdminProvider({ children }: { children: ReactNode }) {
  const [role, setRole] = useState<AdminRole>(null);
  const [loading, setLoading] = useState(true);
  const { user } = useAuth();

  const checkAdminStatus = async () => {
    if (!user) {
      setRole(null);
      setLoading(false);
      return;
    }

    try {
      // Query user_roles table for all roles and get highest
      const { data, error } = await pronghornApi
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id);

      if (error) {
        console.error("Error checking admin status:", error);
        setRole(null);
      } else if (data && data.length > 0) {
        // Get highest role: superadmin > admin > user
        const roles = data.map(r => r.role);
        if (roles.includes("superadmin")) {
          setRole("superadmin");
        } else if (roles.includes("admin")) {
          setRole("admin");
        } else {
          setRole("user");
        }
      } else {
        setRole("user"); // Default role if no role entry
      }
    } catch (err) {
      console.error("Error checking admin status:", err);
      setRole(null);
    } finally {
      setLoading(false);
    }
  };

  // Check admin status when user changes
  useEffect(() => {
    checkAdminStatus();
  }, [user]);

  const refreshAdminStatus = async () => {
    setLoading(true);
    await checkAdminStatus();
  };

  const isAdmin = role === "admin" || role === "superadmin";
  const isSuperAdmin = role === "superadmin";

  return (
    <AdminContext.Provider value={{ isAdmin, isSuperAdmin, role, loading, refreshAdminStatus }}>
      {children}
    </AdminContext.Provider>
  );
}

export function useAdmin() {
  const context = useContext(AdminContext);
  if (!context) {
    throw new Error("useAdmin must be used within AdminProvider");
  }
  return context;
}
