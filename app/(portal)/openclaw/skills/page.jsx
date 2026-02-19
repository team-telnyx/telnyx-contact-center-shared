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
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  IconSearch,
  IconDownload,
  IconExternalLink,
  IconRefresh,
  IconSortDescending,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";

export default function OpenClawSkillsPage() {
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("popular");

  const fetchSkills = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (sort) params.set("sort", sort);
      if (search) params.set("search", search);
      const res = await fetch(`/api/openclaw/skills?${params}`);
      const json = await res.json();
      setSkills(json);
    } catch (e) {
      console.error("Failed to fetch skills:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSkills();
  }, [sort]);

  useEffect(() => {
    const t = setTimeout(fetchSkills, 300);
    return () => clearTimeout(t);
  }, [search]);

  const categoryColor = {
    Voice: "bg-blue-500/10 text-blue-500",
    AI: "bg-purple-500/10 text-purple-500",
    Routing: "bg-green-500/10 text-green-500",
    Integration: "bg-orange-500/10 text-orange-500",
  };

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">ClawHub Skills</h1>
        <p className="text-muted-foreground">Browse and discover skills from the ClawHub registry</p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <IconSearch className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search skills..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button
          variant={sort === "popular" ? "default" : "outline"}
          size="sm"
          onClick={() => setSort(sort === "popular" ? "" : "popular")}
        >
          <IconSortDescending className="mr-2 h-4 w-4" />
          Popular
        </Button>
      </div>

      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-4 w-48 mt-1" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-4 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : skills.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">No skills found.</div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {skills.map((skill) => (
            <Card key={skill.id} className="flex flex-col">
              <CardHeader>
                <div className="flex items-start justify-between">
                  <CardTitle className="text-lg">{skill.name}</CardTitle>
                  <Badge variant="secondary" className={cn("text-xs", categoryColor[skill.category])}>
                    {skill.category}
                  </Badge>
                </div>
                <CardDescription className="text-xs">by {skill.author}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col justify-between gap-4">
                <p className="text-sm text-muted-foreground">{skill.description}</p>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <IconDownload className="h-3.5 w-3.5" />
                    {skill.installs.toLocaleString()} installs
                  </span>
                  <Button variant="outline" size="sm" asChild>
                    <a href={skill.url} target="_blank" rel="noopener noreferrer">
                      <IconExternalLink className="mr-1 h-3.5 w-3.5" />
                      View
                    </a>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
