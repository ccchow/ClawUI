"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface InputCardProps {
  title: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
}

export function InputCard({ title, placeholder, onSubmit }: InputCardProps) {
  const [value, setValue] = useState("");

  const handleSubmit = () => {
    if (!value.trim()) return;
    onSubmit(value);
    setValue("");
  };

  return (
    <Card className="border-blue-500/50 bg-blue-500/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm text-blue-400">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex gap-2">
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            placeholder={placeholder ?? "Type your response..."}
            className="text-sm min-h-[44px]"
          />
          <Button size="sm" className="min-h-[44px] min-w-[44px] px-4" onClick={handleSubmit}>
            Send
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
