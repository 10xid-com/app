import type { IconName } from "./icons";

/**
 * The sidebar's sections, and what each placeholder will become.
 *
 * Paolo's sketch of 2026-10-08 laid the portal out as a sidebar, the page, and
 * Chat Boss on the right. Most of the sidebar is screens that do not exist yet;
 * they are in the nav now, each with a page that says what it will be, so the
 * shape of the product is visible before every part of it is built. A section
 * that ships keeps its row here and loses its `soon` copy.
 *
 * Plain data with no imports beyond a type, so the server can build the nav
 * from it and the placeholder pages can read their own copy from it.
 */

export type NavLink = {
  href: string;
  label: string;
  icon: IconName;
};

export type ComingSoon = NavLink & {
  /** One line: what this screen will be for. */
  blurb: string;
  /** What will be on it, in a few short items. */
  plans: string[];
};

export const SOON = {
  orders: {
    href: "/orders",
    label: "Orders",
    icon: "orders",
    blurb: "Every order that comes in, from every channel, in one list.",
    plans: ["Orders from your iD, website and shops", "Payment and fulfilment status", "Refunds and returns"],
  },
  products: {
    href: "/products",
    label: "Products",
    icon: "products",
    blurb: "What you sell: the catalogue every channel draws from.",
    plans: ["Products, variants and prices", "Photos and descriptions", "Stock levels"],
  },
  customers: {
    href: "/customers",
    label: "Customers",
    icon: "customers",
    blurb: "The people who buy from you, and what they have bought.",
    plans: ["Customer list and history", "Segments", "Notes and contact details"],
  },
  growth: {
    href: "/growth",
    label: "Growth",
    icon: "growth",
    blurb: "Campaigns and the work that brings new customers in.",
    plans: ["Campaigns across your channels", "Email and social", "What each one brought in"],
  },
  discounts: {
    href: "/discounts",
    label: "Discounts",
    icon: "discounts",
    blurb: "Codes and automatic offers.",
    plans: ["Discount codes", "Automatic offers", "How often each is used"],
  },
  content: {
    href: "/content",
    label: "Content",
    icon: "content",
    blurb: "Pages, posts, files and media, in one library.",
    plans: ["Pages and blog posts", "Images and files", "Menus"],
  },
  markets: {
    href: "/markets",
    label: "Markets",
    icon: "markets",
    blurb: "Where you sell, and the currencies and languages each place gets.",
    plans: ["Regions and currencies", "Languages", "Local pricing"],
  },
  finance: {
    href: "/finance",
    label: "Finance",
    icon: "finance",
    blurb: "Payouts, billing and the money side of the business.",
    plans: ["Payouts", "Invoices and billing", "Tax settings"],
  },
  analytics: {
    href: "/analytics",
    label: "Analytics",
    icon: "analytics",
    blurb: "How the business is doing, in numbers.",
    plans: ["Sales and traffic", "Reports", "Live view"],
  },
  settings: {
    href: "/settings",
    label: "Settings",
    icon: "settings",
    blurb: "The business's details and how the portal works for it.",
    plans: ["Business details and branding", "Domains", "Notifications"],
  },
  channels: {
    href: "/channels",
    label: "Channels",
    icon: "channels",
    blurb: "Everywhere the business shows up. Add whichever ones you use.",
    plans: ["Connect a channel", "Publish to several at once", "See what each brings in"],
  },
} satisfies Record<string, ComingSoon>;

/**
 * Channels other than the iD itself, which has its own page. The sidebar lists
 * these; /channels/[channel] answers for exactly these names and no others.
 */
export const CHANNELS = {
  website: {
    href: "/channels/website",
    label: "Website",
    icon: "website",
    blurb: "Your website, run from here alongside your iD.",
    plans: ["Connect an existing site", "Pages and menus", "Domain"],
  },
  instagram: {
    href: "/channels/instagram",
    label: "Instagram",
    icon: "instagram",
    blurb: "Post to Instagram and see what lands.",
    plans: ["Connect an account", "Schedule posts", "Messages and comments"],
  },
  linkedin: {
    href: "/channels/linkedin",
    label: "LinkedIn",
    icon: "linkedin",
    blurb: "Post to LinkedIn as the business.",
    plans: ["Connect a company page", "Schedule posts", "Reach and engagement"],
  },
} satisfies Record<string, ComingSoon>;

export type ChannelName = keyof typeof CHANNELS;

export function isChannelName(name: string): name is ChannelName {
  return Object.hasOwn(CHANNELS, name);
}

export const ID_CHANNEL: NavLink = { href: "/channels/id", label: "iD", icon: "id" };
