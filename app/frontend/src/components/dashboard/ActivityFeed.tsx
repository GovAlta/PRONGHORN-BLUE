import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Clock, GitBranch, ShieldCheck, CheckCircle2, AlertCircle } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface ActivityItem {
  id: string;
  type: "build" | "audit" | "standard" | "member";
  message: string;
  project: string;
  timestamp: Date;
  status?: "success" | "error" | "info";
}

interface ActivityFeedProps {
  activities: ActivityItem[];
}

const activityIcons = {
  build: GitBranch,
  audit: ShieldCheck,
  standard: CheckCircle2,
  member: AlertCircle,
};

const statusColors = {
  success: "bg-success/10 text-success",
  error: "bg-destructive/10 text-destructive",
  info: "bg-info/10 text-info",
};

export function ActivityFeed({ activities }: ActivityFeedProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Activity</CardTitle>
        <CardDescription>
          Latest events across all your projects
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[400px] pr-4">
          <div className="space-y-4">
            {activities.map((activity) => {
              const Icon = activityIcons[activity.type];
              return (
                <div
                  key={activity.id}
                  className="flex items-start gap-3 p-3 rounded-lg hover:bg-muted/50 transition-colors"
                >
                  <div className="mt-0.5">
                    <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
                      <Icon className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </div>
                  <div className="flex-1 space-y-1">
                    <p className="text-sm leading-relaxed">{activity.message}</p>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="text-xs">
                        {activity.project}
                      </Badge>
                      {activity.status && (
                        <Badge
                          variant="secondary"
                          className={`text-xs ${statusColors[activity.status]}`}
                        >
                          {activity.status}
                        </Badge>
                      )}
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {formatDistanceToNow(activity.timestamp, { addSuffix: true })}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
