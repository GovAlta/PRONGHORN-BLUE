import { useState, useEffect } from "react";
import { PrimaryNav } from "@/components/layout/PrimaryNav";
import { useAdmin } from "@/contexts/AdminContext";
import { useAuth } from "@/contexts/AuthContext";
import { pronghornApi } from "@/integrations/pronghorn-api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, UserPlus, Trash2, ShieldCheck, Crown, User, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";

interface AdminUser {
  user_id: string;
  email: string;
  display_name: string | null;
  role: string;
  last_login: string | null;
  created_at: string;
}

export default function Settings() {
  const { isAdmin, isSuperAdmin, role, loading: adminLoading } = useAdmin();
  const { user } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  
  // Add/Edit user form
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "user">("admin");
  
  // Delete confirmation
  const [deleteEmail, setDeleteEmail] = useState("");
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [userToDelete, setUserToDelete] = useState<AdminUser | null>(null);

  const fetchUsers = async () => {
    if (!isAdmin) return;
    
    setLoading(true);
    try {
      const { data, error } = await pronghornApi.functions.invoke("admin-management", {
        body: { action: "list_users" },
      });
      
      if (error) throw error;
      if (data.error) throw new Error(data.error);
      
      setUsers(data.users || []);
    } catch (err: unknown) {
      console.error("Error fetching users:", err);
      const message = err instanceof Error ? err.message : "Failed to fetch users";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isAdmin && !adminLoading) {
      fetchUsers();
    }
  }, [isAdmin, adminLoading]);

  const handleSetRole = async () => {
    if (!newEmail.trim()) {
      toast.error("Email is required");
      return;
    }

    setActionLoading(true);
    try {
      const { data, error } = await pronghornApi.functions.invoke("admin-management", {
        body: { action: "set_role", email: newEmail.trim(), role: newRole },
      });
      
      if (error) throw error;
      if (data.error) throw new Error(data.error);
      
      toast.success(data.message || "Role updated successfully");
      setNewEmail("");
      fetchUsers();
    } catch (err: unknown) {
      console.error("Error setting role:", err);
      const message = err instanceof Error ? err.message : "Failed to set role";
      toast.error(message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteUser = async () => {
    if (!deleteEmail.trim()) {
      toast.error("Email is required");
      return;
    }

    setActionLoading(true);
    try {
      const { data, error } = await pronghornApi.functions.invoke("admin-management", {
        body: { action: "delete_user", email: deleteEmail.trim() },
      });
      
      if (error) throw error;
      if (data.error) throw new Error(data.error);
      
      toast.success(data.message || "User deleted successfully");
      setDeleteEmail("");
      setShowDeleteDialog(false);
      setUserToDelete(null);
      fetchUsers();
    } catch (err: unknown) {
      console.error("Error deleting user:", err);
      const message = err instanceof Error ? err.message : "Failed to delete user";
      toast.error(message);
    } finally {
      setActionLoading(false);
    }
  };

  const confirmDelete = (userItem: AdminUser) => {
    setUserToDelete(userItem);
    setDeleteEmail(userItem.email);
    setShowDeleteDialog(true);
  };

  const getRoleBadge = (userRole: string) => {
    switch (userRole) {
      case "superadmin":
        return (
          <Badge className="gap-1 bg-purple-600 hover:bg-purple-700">
            <Crown className="h-3 w-3" />
            Superadmin
          </Badge>
        );
      case "admin":
        return (
          <Badge variant="default" className="gap-1">
            <ShieldCheck className="h-3 w-3" />
            Admin
          </Badge>
        );
      default:
        return (
          <Badge variant="secondary" className="gap-1">
            <User className="h-3 w-3" />
            User
          </Badge>
        );
    }
  };

  // Not authenticated
  if (!user) {
    return (
      <div className="min-h-screen bg-background">
        <PrimaryNav />
        <main className="container px-6 py-8">
          <h1 className="text-3xl font-bold mb-4">Settings</h1>
          <p className="text-muted-foreground">Please sign in to access settings.</p>
        </main>
      </div>
    );
  }

  // Loading admin status
  if (adminLoading) {
    return (
      <div className="min-h-screen bg-background">
        <PrimaryNav />
        <main className="container px-6 py-8 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </main>
      </div>
    );
  }

  // Not admin
  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-background">
        <PrimaryNav />
        <main className="container px-6 py-8">
          <h1 className="text-3xl font-bold mb-4">Settings</h1>
          <p className="text-muted-foreground">Access denied. Admin privileges required.</p>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <PrimaryNav />
      <main className="container px-6 py-8 max-w-6xl">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold">Admin User Management</h1>
            <p className="text-muted-foreground mt-1">
              {isSuperAdmin 
                ? "View and manage all users in the platform" 
                : "View and manage admin users"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {getRoleBadge(role || "user")}
          </div>
        </div>

        <div className="grid gap-6 md:grid-cols-2 mb-8">
          {/* Add/Update User Role */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <UserPlus className="h-5 w-5" />
                Set User Role
              </CardTitle>
              <CardDescription>
                Add or update a user's role by their email address
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">User Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="user@example.com"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="role">Role</Label>
                <Select value={newRole} onValueChange={(v) => setNewRole(v as "admin" | "user")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="user">User</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={handleSetRole} disabled={actionLoading} className="w-full">
                {actionLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <UserPlus className="h-4 w-4 mr-2" />
                )}
                Set Role
              </Button>
            </CardContent>
          </Card>

          {/* Delete User */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-destructive">
                <Trash2 className="h-5 w-5" />
                Delete User Account
              </CardTitle>
              <CardDescription>
                Permanently delete a user account by email
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="delete-email">User Email</Label>
                <Input
                  id="delete-email"
                  type="email"
                  placeholder="user@example.com"
                  value={deleteEmail}
                  onChange={(e) => setDeleteEmail(e.target.value)}
                />
              </div>
              <Button 
                variant="destructive" 
                onClick={() => setShowDeleteDialog(true)} 
                disabled={actionLoading || !deleteEmail.trim()}
                className="w-full"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete User
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Users Table */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>
                  {isSuperAdmin ? "All Users" : "Admin Users"}
                </CardTitle>
                <CardDescription>
                  {isSuperAdmin 
                    ? "Complete list of platform users"
                    : "Other admins and superadmins on the platform"}
                </CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={fetchUsers} disabled={loading}>
                <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : users.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">No users found</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Email</TableHead>
                      <TableHead>Display Name</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Last Login</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.map((userItem) => (
                      <TableRow key={userItem.user_id}>
                        <TableCell className="font-medium">
                          {userItem.email}
                          {userItem.user_id === user?.id && (
                            <Badge variant="outline" className="ml-2">You</Badge>
                          )}
                        </TableCell>
                        <TableCell>{userItem.display_name || "—"}</TableCell>
                        <TableCell>{getRoleBadge(userItem.role)}</TableCell>
                        <TableCell>
                          {userItem.last_login 
                            ? format(new Date(userItem.last_login), "MMM d, yyyy HH:mm")
                            : "Never"}
                        </TableCell>
                        <TableCell>
                          {format(new Date(userItem.created_at), "MMM d, yyyy")}
                        </TableCell>
                        <TableCell className="text-right">
                          {userItem.user_id !== user?.id && userItem.role !== "superadmin" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => confirmDelete(userItem)}
                              className="text-destructive hover:text-destructive"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </main>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete User Account</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this user account? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm">
              <strong>Email:</strong> {userToDelete?.email || deleteEmail}
            </p>
            {userToDelete && (
              <p className="text-sm">
                <strong>Role:</strong> {userToDelete.role}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeleteUser} disabled={actionLoading}>
              {actionLoading ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Trash2 className="h-4 w-4 mr-2" />
              )}
              Delete User
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
