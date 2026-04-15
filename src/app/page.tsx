import { redirect } from "next/navigation";

// Root redirects to the discovery landing page.
// Direct embed usage goes to /embed/ai-phil?context=...
export default function Home() {
  redirect("/discover");
}
