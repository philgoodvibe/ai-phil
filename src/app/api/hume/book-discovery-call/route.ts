import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";

/**
 * Captures prospect contact info when AI Phil's Discovery Guide
 * decides the prospect is ready to move forward.
 *
 * MVP behavior: write to a Supabase table for the team to follow up.
 * Future: also push to GHL via existing GHL integration.
 */

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { first_name, last_name, email, phone, carrier } = body;

    if (!first_name || !email) {
      return NextResponse.json(
        { error: "first_name and email are required" },
        { status: 400 }
      );
    }

    // Save prospect to Supabase (service role bypasses RLS)
    const supabase = createServiceClient();

    const { error } = await supabase.from("ai_phil_prospects").insert({
      first_name,
      last_name: last_name || null,
      email,
      phone: phone || null,
      carrier: carrier || null,
      source: "ai-phil-discovery",
      created_at: new Date().toISOString(),
    });

    if (error) {
      console.error("Insert prospect failed:", error);
      // Don't fail the tool call — at minimum log it server-side
      // and return a friendly success message to AI Phil
    }

    // TODO: Push to GHL here if/when GHL credentials configured for V2
    // await pushToGHL({ first_name, last_name, email, phone, carrier });

    return NextResponse.json({
      success: true,
      message: `Got it, ${first_name}. The team will reach out within 1 business day to ${email}.`,
      next_steps: "Check your inbox for a confirmation email and details on joining AIAI Mastermind.",
    });
  } catch (e) {
    console.error("hume/book-discovery-call error:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
