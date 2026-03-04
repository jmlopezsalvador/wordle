export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: { id: string; username: string | null; avatar_url: string | null; created_at: string };
        Insert: { id: string; username?: string | null; avatar_url?: string | null; created_at?: string };
        Update: { username?: string | null; avatar_url?: string | null };
      };
      groups: {
        Row: {
          id: string;
          name: string;
          code: string;
          icon_url: string | null;
          entry_mode: "daily" | "history";
          owner_id: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          code: string;
          icon_url?: string | null;
          entry_mode?: "daily" | "history";
          owner_id: string;
          created_at?: string;
        };
        Update: { name?: string; code?: string; icon_url?: string | null; entry_mode?: "daily" | "history" };
      };
      group_members: {
        Row: { group_id: string; user_id: string; role: "owner" | "member"; joined_at: string };
        Insert: { group_id: string; user_id: string; role?: "owner" | "member"; joined_at?: string };
        Update: { role?: "owner" | "member" };
      };
      game_types: {
        Row: { id: number; key: string; label: string; max_attempts: number; active: boolean };
        Insert: { id?: number; key: string; label: string; max_attempts: number; active?: boolean };
        Update: { label?: string; max_attempts?: number; active?: boolean };
      };
      submissions: {
        Row: {
          id: string;
          group_id: string;
          user_id: string;
          game_type_id: number;
          game_edition: number;
          played_on: string;
          attempts: number;
          is_failure: boolean;
          raw_share_text: string;
          grid_rows: string[];
          created_at: string;
        };
        Insert: {
          id?: string;
          group_id: string;
          user_id: string;
          game_type_id: number;
          game_edition: number;
          played_on: string;
          attempts: number;
          is_failure?: boolean;
          raw_share_text: string;
          grid_rows: string[];
          created_at?: string;
        };
        Update: {
          attempts?: number;
          is_failure?: boolean;
          raw_share_text?: string;
          grid_rows?: string[];
          game_edition?: number;
        };
      };
      member_scores: {
        Row: { group_id: string; user_id: string; total_points: number; calculated_through: string; updated_at: string };
        Insert: { group_id: string; user_id: string; total_points?: number; calculated_through?: string; updated_at?: string };
        Update: { total_points?: number; calculated_through?: string; updated_at?: string };
      };
      group_comments: {
        Row: { id: string; group_id: string; user_id: string; comment_date: string; body: string; created_at: string };
        Insert: { id?: string; group_id: string; user_id: string; comment_date: string; body: string; created_at?: string };
        Update: { body?: string };
      };
    };
  };
};
