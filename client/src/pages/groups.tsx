import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Users, Shield, ArrowRight } from "lucide-react";
import type { Group } from "@shared/schema";

export default function GroupsPage() {
  const { data: groups, isLoading } = useQuery<Group[]>({
    queryKey: ["/api/groups"],
  });

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold" data-testid="text-groups-title">Groups</h1>
        <p className="text-muted-foreground">Manage all groups the bot is moderating</p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-4 w-48" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-4 w-24" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : !groups || groups.length === 0 ? (
        <Card>
          <CardContent className="py-12">
            <div className="text-center">
              <Shield className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2" data-testid="text-empty-groups-title">No Groups Found</h3>
              <p className="text-muted-foreground text-sm max-w-md mx-auto" data-testid="text-empty-groups-message">
                Add the bot to a Telegram group to start moderating. The bot will automatically appear here once added.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {groups.map((group) => (
            <Link key={group.chatId} href={`/groups/${group.chatId}`}>
              <Card
                className="hover-elevate cursor-pointer h-full"
                data-testid={`card-group-${group.chatId}`}
              >
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10">
                        <Users className="h-5 w-5 text-primary" />
                      </div>
                      <div className="min-w-0">
                        <CardTitle className="text-base truncate">{group.title}</CardTitle>
                        <CardDescription className="text-xs font-mono">{group.chatId}</CardDescription>
                      </div>
                    </div>
                    <Badge
                      variant={group.isActive ? "default" : "secondary"}
                      className="no-default-hover-elevate shrink-0"
                      data-testid={`badge-group-status-${group.chatId}`}
                    >
                      {group.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-muted-foreground">
                      {group.memberCount?.toLocaleString() ?? 0} members
                    </span>
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
