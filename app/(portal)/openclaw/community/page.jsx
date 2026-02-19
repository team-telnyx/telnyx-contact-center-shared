"use client";

import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  IconExternalLink,
  IconTrendingUp,
  IconSparkles,
  IconUsers,
  IconPuzzle,
  IconDownload,
} from "@tabler/icons-react";

export default function OpenClawCommunityPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/openclaw/community")
      .then((r) => r.json())
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Community Hub</h1>
          <p className="text-muted-foreground">Explore the OpenClaw community on ClawHub</p>
        </div>
        <Button asChild>
          <a href="https://clawhub.ai" target="_blank" rel="noopener noreferrer">
            <IconExternalLink className="mr-2 h-4 w-4" />
            Visit ClawHub
          </a>
        </Button>
      </div>

      {/* Stats */}
      {loading ? (
        <div className="grid gap-4 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardHeader className="pb-2"><Skeleton className="h-4 w-24" /></CardHeader>
              <CardContent><Skeleton className="h-8 w-16" /></CardContent>
            </Card>
          ))}
        </div>
      ) : data?.stats ? (
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardDescription>Total Skills</CardDescription>
              <IconPuzzle className="h-5 w-5 text-blue-500" />
            </CardHeader>
            <CardContent><div className="text-3xl font-bold">{data.stats.totalSkills}</div></CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardDescription>Authors</CardDescription>
              <IconUsers className="h-5 w-5 text-green-500" />
            </CardHeader>
            <CardContent><div className="text-3xl font-bold">{data.stats.totalAuthors}</div></CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardDescription>Total Installs</CardDescription>
              <IconDownload className="h-5 w-5 text-purple-500" />
            </CardHeader>
            <CardContent><div className="text-3xl font-bold">{data.stats.totalInstalls.toLocaleString()}</div></CardContent>
          </Card>
        </div>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2">
        {/* Popular Skills */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <IconTrendingUp className="h-5 w-5" /> Popular Skills
            </CardTitle>
            <CardDescription>Most installed skills this month</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
            ) : (
              <div className="space-y-3">
                {data?.popularSkills?.map((s, i) => (
                  <div key={i} className="flex items-center justify-between rounded-lg border p-3">
                    <div>
                      <p className="font-medium">{s.name}</p>
                      <p className="text-xs text-muted-foreground">by {s.author}</p>
                    </div>
                    <Badge variant="secondary">{s.installs.toLocaleString()} installs</Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent Additions */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <IconSparkles className="h-5 w-5" /> Recent Additions
            </CardTitle>
            <CardDescription>Newest skills added to ClawHub</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
            ) : (
              <div className="space-y-3">
                {data?.recentAdditions?.map((s, i) => (
                  <div key={i} className="flex items-center justify-between rounded-lg border p-3">
                    <div>
                      <p className="font-medium">{s.name}</p>
                      <p className="text-xs text-muted-foreground">by {s.author}</p>
                    </div>
                    <Badge variant="outline">{s.addedAt}</Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
