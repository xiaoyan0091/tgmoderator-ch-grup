import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams } from "wouter";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  ArrowLeft,
  Save,
  MessageSquare,
  Trash2,
  AlertTriangle,
  Ban,
  Users,
  Lock,
  ShieldAlert,
  Activity,
  Settings,
  BarChart3,
  X,
  Plus,
} from "lucide-react";
import type { Group, GroupSettings, BotStats, ActivityLog } from "@shared/schema";

export default function GroupDetailPage() {
  const params = useParams<{ chatId: string }>();
  const chatId = params.chatId;

  const { data: groups } = useQuery<Group[]>({
    queryKey: ["/api/groups"],
  });

  const group = groups?.find((g) => g.chatId === chatId);

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <Link href="/groups">
          <Button variant="ghost" size="icon" data-testid="button-back-groups">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold truncate" data-testid="text-group-title">
            {group?.title ?? chatId}
          </h1>
          <p className="text-sm text-muted-foreground font-mono">{chatId}</p>
        </div>
        {group && (
          <Badge
            variant={group.isActive ? "default" : "secondary"}
            className="no-default-hover-elevate"
            data-testid="badge-group-status"
          >
            {group.isActive ? "Active" : "Inactive"}
          </Badge>
        )}
      </div>

      <Tabs defaultValue="settings">
        <TabsList data-testid="tabs-group-detail">
          <TabsTrigger value="settings" data-testid="tab-settings">
            <Settings className="h-4 w-4 mr-1" />
            Settings
          </TabsTrigger>
          <TabsTrigger value="statistics" data-testid="tab-statistics">
            <BarChart3 className="h-4 w-4 mr-1" />
            Statistics
          </TabsTrigger>
          <TabsTrigger value="activity" data-testid="tab-activity">
            <Activity className="h-4 w-4 mr-1" />
            Activity Log
          </TabsTrigger>
        </TabsList>

        <TabsContent value="settings">
          <SettingsTab chatId={chatId!} />
        </TabsContent>
        <TabsContent value="statistics">
          <StatsTab chatId={chatId!} />
        </TabsContent>
        <TabsContent value="activity">
          <ActivityTab chatId={chatId!} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SettingsTab({ chatId }: { chatId: string }) {
  const { toast } = useToast();
  const { data: settings, isLoading } = useQuery<GroupSettings>({
    queryKey: ["/api/groups", chatId, "settings"],
  });

  const [formState, setFormState] = useState<Partial<GroupSettings>>({});
  const [newChannel, setNewChannel] = useState("");
  const [newBannedWord, setNewBannedWord] = useState("");

  const merged = { ...settings, ...formState };

  const updateMutation = useMutation({
    mutationFn: async (data: Partial<GroupSettings>) => {
      await apiRequest("PATCH", `/api/groups/${chatId}/settings`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/groups", chatId, "settings"] });
      toast({ title: "Settings saved", description: "Group settings have been updated successfully." });
      setFormState({});
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const handleSave = () => {
    updateMutation.mutate(formState);
  };

  const updateField = <K extends keyof GroupSettings>(key: K, value: GroupSettings[K]) => {
    setFormState((prev) => ({ ...prev, [key]: value }));
  };

  const addChannel = () => {
    if (!newChannel.trim()) return;
    const current = (merged.forceJoinChannels as string[]) ?? [];
    if (!current.includes(newChannel.trim())) {
      updateField("forceJoinChannels", [...current, newChannel.trim()]);
    }
    setNewChannel("");
  };

  const removeChannel = (ch: string) => {
    const current = (merged.forceJoinChannels as string[]) ?? [];
    updateField("forceJoinChannels", current.filter((c) => c !== ch));
  };

  const addBannedWord = () => {
    if (!newBannedWord.trim()) return;
    const current = (merged.bannedWords as string[]) ?? [];
    if (!current.includes(newBannedWord.trim())) {
      updateField("bannedWords", [...current, newBannedWord.trim()]);
    }
    setNewBannedWord("");
  };

  const removeBannedWord = (word: string) => {
    const current = (merged.bannedWords as string[]) ?? [];
    updateField("bannedWords", current.filter((w) => w !== word));
  };

  if (isLoading) {
    return (
      <div className="space-y-4 mt-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-5 w-40" />
            </CardHeader>
            <CardContent className="space-y-3">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Welcome Message</CardTitle>
          <CardDescription>Greet new members when they join</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="welcome-enabled">Enable welcome messages</Label>
            <Switch
              id="welcome-enabled"
              data-testid="switch-welcome-enabled"
              checked={merged.welcomeEnabled ?? true}
              onCheckedChange={(val) => updateField("welcomeEnabled", val)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="welcome-message">Message template</Label>
            <Textarea
              id="welcome-message"
              data-testid="input-welcome-message"
              value={merged.welcomeMessage ?? ""}
              onChange={(e) => updateField("welcomeMessage", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Use {"{user}"} for username and {"{group}"} for group name
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Force Join</CardTitle>
          <CardDescription>Require users to join channels before chatting</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="force-join-enabled">Enable force join</Label>
            <Switch
              id="force-join-enabled"
              data-testid="switch-force-join-enabled"
              checked={merged.forceJoinEnabled ?? false}
              onCheckedChange={(val) => updateField("forceJoinEnabled", val)}
            />
          </div>
          <div className="space-y-2">
            <Label>Required channels</Label>
            <div className="flex flex-wrap gap-2">
              {((merged.forceJoinChannels as string[]) ?? []).map((ch) => (
                <Badge key={ch} variant="secondary" className="gap-1">
                  @{ch}
                  <button
                    onClick={() => removeChannel(ch)}
                    data-testid={`button-remove-channel-${ch}`}
                    className="ml-1"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
            <div className="flex gap-2">
              <Input
                placeholder="channel_username"
                data-testid="input-new-channel"
                value={newChannel}
                onChange={(e) => setNewChannel(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addChannel())}
              />
              <Button variant="outline" onClick={addChannel} data-testid="button-add-channel">
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Anti-Spam</CardTitle>
          <CardDescription>Detect and block spam messages</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="anti-spam-enabled">Enable anti-spam</Label>
            <Switch
              id="anti-spam-enabled"
              data-testid="switch-anti-spam-enabled"
              checked={merged.antiSpamEnabled ?? true}
              onCheckedChange={(val) => updateField("antiSpamEnabled", val)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="anti-spam-max">Max messages before trigger</Label>
            <Input
              id="anti-spam-max"
              type="number"
              data-testid="input-anti-spam-max"
              value={merged.antiSpamMaxMessages ?? 5}
              onChange={(e) => updateField("antiSpamMaxMessages", parseInt(e.target.value) || 5)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Anti-Link</CardTitle>
          <CardDescription>Remove messages containing links</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="anti-link-enabled">Enable anti-link</Label>
            <Switch
              id="anti-link-enabled"
              data-testid="switch-anti-link-enabled"
              checked={merged.antiLinkEnabled ?? false}
              onCheckedChange={(val) => updateField("antiLinkEnabled", val)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Word Filter</CardTitle>
          <CardDescription>Block messages containing specific words</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="word-filter-enabled">Enable word filter</Label>
            <Switch
              id="word-filter-enabled"
              data-testid="switch-word-filter-enabled"
              checked={merged.wordFilterEnabled ?? false}
              onCheckedChange={(val) => updateField("wordFilterEnabled", val)}
            />
          </div>
          <div className="space-y-2">
            <Label>Banned words</Label>
            <div className="flex flex-wrap gap-2">
              {((merged.bannedWords as string[]) ?? []).map((word) => (
                <Badge key={word} variant="secondary" className="gap-1">
                  {word}
                  <button
                    onClick={() => removeBannedWord(word)}
                    data-testid={`button-remove-word-${word}`}
                    className="ml-1"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
            <div className="flex gap-2">
              <Input
                placeholder="Add banned word"
                data-testid="input-new-banned-word"
                value={newBannedWord}
                onChange={(e) => setNewBannedWord(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addBannedWord())}
              />
              <Button variant="outline" onClick={addBannedWord} data-testid="button-add-banned-word">
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Anti-Flood</CardTitle>
          <CardDescription>Prevent message flooding</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="anti-flood-enabled">Enable anti-flood</Label>
            <Switch
              id="anti-flood-enabled"
              data-testid="switch-anti-flood-enabled"
              checked={merged.antiFloodEnabled ?? true}
              onCheckedChange={(val) => updateField("antiFloodEnabled", val)}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="anti-flood-messages">Max messages</Label>
              <Input
                id="anti-flood-messages"
                type="number"
                data-testid="input-anti-flood-messages"
                value={merged.antiFloodMessages ?? 10}
                onChange={(e) => updateField("antiFloodMessages", parseInt(e.target.value) || 10)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="anti-flood-seconds">Time window (seconds)</Label>
              <Input
                id="anti-flood-seconds"
                type="number"
                data-testid="input-anti-flood-seconds"
                value={merged.antiFloodSeconds ?? 60}
                onChange={(e) => updateField("antiFloodSeconds", parseInt(e.target.value) || 60)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Warning System</CardTitle>
          <CardDescription>Configure warning limits and actions</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="warn-limit">Warning limit</Label>
            <Input
              id="warn-limit"
              type="number"
              data-testid="input-warn-limit"
              value={merged.warnLimit ?? 3}
              onChange={(e) => updateField("warnLimit", parseInt(e.target.value) || 3)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="warn-action">Action on limit reached</Label>
            <Select
              value={merged.warnAction ?? "mute"}
              onValueChange={(val) => updateField("warnAction", val)}
            >
              <SelectTrigger data-testid="select-warn-action">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mute">Mute</SelectItem>
                <SelectItem value="kick">Kick</SelectItem>
                <SelectItem value="ban">Ban</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Mute New Members</CardTitle>
          <CardDescription>Temporarily mute new members when they join</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="mute-new-members">Enable mute on join</Label>
            <Switch
              id="mute-new-members"
              data-testid="switch-mute-new-members"
              checked={merged.muteNewMembers ?? false}
              onCheckedChange={(val) => updateField("muteNewMembers", val)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="mute-duration">Duration (seconds)</Label>
            <Input
              id="mute-duration"
              type="number"
              data-testid="input-mute-duration"
              value={merged.muteNewMembersDuration ?? 300}
              onChange={(e) => updateField("muteNewMembersDuration", parseInt(e.target.value) || 300)}
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end pb-6">
        <Button
          onClick={handleSave}
          disabled={updateMutation.isPending || Object.keys(formState).length === 0}
          data-testid="button-save-settings"
        >
          <Save className="h-4 w-4 mr-1" />
          {updateMutation.isPending ? "Saving..." : "Save Settings"}
        </Button>
      </div>
    </div>
  );
}

function StatsTab({ chatId }: { chatId: string }) {
  const { data: stats, isLoading } = useQuery<BotStats>({
    queryKey: ["/api/groups", chatId, "stats"],
  });

  const statCards = [
    { label: "Messages Processed", value: stats?.messagesProcessed ?? 0, icon: MessageSquare, color: "text-green-500" },
    { label: "Messages Deleted", value: stats?.messagesDeleted ?? 0, icon: Trash2, color: "text-orange-500" },
    { label: "Users Warned", value: stats?.usersWarned ?? 0, icon: AlertTriangle, color: "text-yellow-500" },
    { label: "Users Banned", value: stats?.usersBanned ?? 0, icon: Ban, color: "text-red-500" },
    { label: "Users Kicked", value: stats?.usersKicked ?? 0, icon: Users, color: "text-indigo-500" },
    { label: "Users Muted", value: stats?.usersMuted ?? 0, icon: Lock, color: "text-purple-500" },
    { label: "Spam Blocked", value: stats?.spamBlocked ?? 0, icon: ShieldAlert, color: "text-pink-500" },
    { label: "Force Join Blocked", value: stats?.forceJoinBlocked ?? 0, icon: Lock, color: "text-cyan-500" },
  ];

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Card key={i}>
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-4" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-16" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-4">
      {statCards.map((stat) => (
        <Card key={stat.label} data-testid={`card-group-stat-${stat.label.toLowerCase().replace(/\s+/g, "-")}`}>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {stat.label}
            </CardTitle>
            <stat.icon className={`h-4 w-4 ${stat.color}`} />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid={`text-group-stat-${stat.label.toLowerCase().replace(/\s+/g, "-")}`}>
              {stat.value.toLocaleString()}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function ActivityTab({ chatId }: { chatId: string }) {
  const { data: logs, isLoading } = useQuery<ActivityLog[]>({
    queryKey: ["/api/groups", chatId, "logs"],
  });

  const actionColors: Record<string, string> = {
    warn: "text-yellow-500",
    ban: "text-red-500",
    mute: "text-purple-500",
    kick: "text-orange-500",
    delete: "text-muted-foreground",
  };

  if (isLoading) {
    return (
      <div className="space-y-3 mt-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  }

  if (!logs || logs.length === 0) {
    return (
      <Card className="mt-4">
        <CardContent className="py-12">
          <div className="text-center">
            <Activity className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No Activity</h3>
            <p className="text-muted-foreground text-sm" data-testid="text-no-group-activity">
              No moderation actions have been recorded for this group yet.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="mt-4">
      <CardContent className="p-0">
        <div className="divide-y divide-border">
          {logs.map((log) => (
            <div
              key={log.id}
              className="flex items-center gap-4 p-4"
              data-testid={`row-activity-${log.id}`}
            >
              <Badge
                variant="outline"
                className={`no-default-hover-elevate shrink-0 ${actionColors[log.action.toLowerCase()] || ""}`}
              >
                {log.action}
              </Badge>
              <div className="min-w-0 flex-1">
                <p className="text-sm">
                  <span className="font-medium">{log.performedBy}</span>
                  <span className="text-muted-foreground mx-1">on</span>
                  <span className="font-medium">{log.targetUser}</span>
                </p>
                {log.details && (
                  <p className="text-xs text-muted-foreground truncate">{log.details}</p>
                )}
              </div>
              <span className="text-xs text-muted-foreground shrink-0">
                {log.createdAt ? new Date(log.createdAt).toLocaleString() : ""}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
