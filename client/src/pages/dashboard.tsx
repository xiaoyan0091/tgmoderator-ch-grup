import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Shield,
  Users,
  MessageSquare,
  Trash2,
  AlertTriangle,
  Ban,
  ShieldAlert,
  Lock,
  ArrowRight,
  Activity,
} from "lucide-react";
import type { Group, ActivityLog } from "@shared/schema";

export default function DashboardPage() {
  const { data: groups, isLoading: groupsLoading } = useQuery<Group[]>({
    queryKey: ["/api/groups"],
  });

  const { data: statsOverview, isLoading: statsLoading } = useQuery<{
    totalGroups: number;
    messagesProcessed: number;
    messagesDeleted: number;
    usersWarned: number;
    usersBanned: number;
    usersKicked: number;
    usersMuted: number;
    spamBlocked: number;
    forceJoinBlocked: number;
  }>({
    queryKey: ["/api/stats/overview"],
  });

  const stats = [
    { label: "Total Groups", value: statsOverview?.totalGroups ?? 0, icon: Users, color: "text-blue-500" },
    { label: "Messages Processed", value: statsOverview?.messagesProcessed ?? 0, icon: MessageSquare, color: "text-green-500" },
    { label: "Messages Deleted", value: statsOverview?.messagesDeleted ?? 0, icon: Trash2, color: "text-orange-500" },
    { label: "Users Warned", value: statsOverview?.usersWarned ?? 0, icon: AlertTriangle, color: "text-yellow-500" },
    { label: "Users Banned", value: statsOverview?.usersBanned ?? 0, icon: Ban, color: "text-red-500" },
    { label: "Spam Blocked", value: statsOverview?.spamBlocked ?? 0, icon: ShieldAlert, color: "text-purple-500" },
    { label: "Force Join Blocked", value: statsOverview?.forceJoinBlocked ?? 0, icon: Lock, color: "text-cyan-500" },
  ];

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-dashboard-title">TG Moderator Bot</h1>
          <p className="text-muted-foreground">Telegram group moderation dashboard</p>
        </div>
        <Badge variant="default" data-testid="badge-bot-status" className="no-default-hover-elevate">
          <Activity className="h-3 w-3 mr-1" />
          Online
        </Badge>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {statsLoading
          ? Array.from({ length: 7 }).map((_, i) => (
              <Card key={i}>
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-4 w-4" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-8 w-16" />
                </CardContent>
              </Card>
            ))
          : stats.map((stat) => (
              <Card key={stat.label} data-testid={`card-stat-${stat.label.toLowerCase().replace(/\s+/g, "-")}`}>
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    {stat.label}
                  </CardTitle>
                  <stat.icon className={`h-4 w-4 ${stat.color}`} />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold" data-testid={`text-stat-${stat.label.toLowerCase().replace(/\s+/g, "-")}`}>
                    {stat.value.toLocaleString()}
                  </div>
                </CardContent>
              </Card>
            ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Managed Groups</CardTitle>
            <CardDescription>Groups the bot is actively moderating</CardDescription>
          </CardHeader>
          <CardContent>
            {groupsLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : !groups || groups.length === 0 ? (
              <div className="text-center py-8">
                <Shield className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
                <p className="text-muted-foreground text-sm" data-testid="text-no-groups">
                  No groups yet. Add the bot to a Telegram group to get started.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {groups.slice(0, 5).map((group) => (
                  <Link key={group.chatId} href={`/groups/${group.chatId}`}>
                    <div
                      className="flex items-center justify-between gap-2 p-3 rounded-md hover-elevate cursor-pointer"
                      data-testid={`link-group-${group.chatId}`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
                          <Users className="h-4 w-4 text-primary" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{group.title}</p>
                          <p className="text-xs text-muted-foreground">{group.memberCount} members</p>
                        </div>
                      </div>
                      <Badge variant={group.isActive ? "default" : "secondary"} className="no-default-hover-elevate shrink-0">
                        {group.isActive ? "Active" : "Inactive"}
                      </Badge>
                    </div>
                  </Link>
                ))}
                {groups.length > 5 && (
                  <Link href="/groups">
                    <Button variant="ghost" className="w-full mt-2" data-testid="link-view-all-groups">
                      View all groups
                      <ArrowRight className="h-4 w-4 ml-1" />
                    </Button>
                  </Link>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <RecentActivity />
      </div>
    </div>
  );
}

function RecentActivity() {
  const { data: logs, isLoading } = useQuery<ActivityLog[]>({
    queryKey: ["/api/logs/recent"],
  });

  const actionIcons: Record<string, typeof AlertTriangle> = {
    warn: AlertTriangle,
    ban: Ban,
    mute: Lock,
    kick: Users,
    delete: Trash2,
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Recent Activity</CardTitle>
        <CardDescription>Latest moderation actions</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : !logs || logs.length === 0 ? (
          <div className="text-center py-8">
            <Activity className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
            <p className="text-muted-foreground text-sm" data-testid="text-no-activity">
              No recent activity to display.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {logs.slice(0, 8).map((log) => {
              const Icon = actionIcons[log.action.toLowerCase()] || Activity;
              return (
                <div
                  key={log.id}
                  className="flex items-start gap-3 p-2 rounded-md"
                  data-testid={`activity-log-${log.id}`}
                >
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted">
                    <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">
                      <span className="font-medium">{log.performedBy}</span>{" "}
                      <span className="text-muted-foreground">{log.action}</span>{" "}
                      <span className="font-medium">{log.targetUser}</span>
                    </p>
                    {log.details && (
                      <p className="text-xs text-muted-foreground truncate">{log.details}</p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {log.createdAt ? new Date(log.createdAt).toLocaleString() : ""}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
