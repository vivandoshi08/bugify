import type { Metadata } from "next";
import { NorthwindView } from "@/components/northwind/NorthwindView";

export const metadata: Metadata = {
  title: "Northwind · Black Box Bazaar",
  description: "The deployer's side: the agents Northwind runs in production, and what the Bazaar has found in them.",
};

export default function NorthwindPage() {
  return <NorthwindView />;
}
