import Link from 'next/link';
import { LayoutGrid, ShieldCheck, Sparkles } from 'lucide-react';

export default function Home() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-gradient-to-br from-background via-white to-secondary/10">
      <div
        className="pointer-events-none absolute -top-24 right-0 h-80 w-80 rounded-full bg-primary/20 blur-3xl"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute bottom-0 left-0 h-72 w-72 rounded-full bg-accent/20 blur-3xl"
        aria-hidden="true"
      />

      <section className="mx-auto flex min-h-[70vh] max-w-6xl flex-col items-start justify-center gap-10 px-4 py-16 sm:py-24">
        <div className="flex w-full flex-col gap-8 lg:grid lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
          <div className="space-y-6">
            <p className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-white/70 px-4 py-2 text-sm font-semibold uppercase tracking-[0.2em] text-primary shadow-soft">
              Smart shopping lists
            </p>
            <h1 className="font-heading text-5xl font-black leading-tight text-foreground sm:text-6xl">
              Clickmoji Shop makes grocery planning visual, fast, and fun.
            </h1>
            <p className="max-w-xl text-lg text-muted-foreground sm:text-xl">
              Replace typed lists with expressive emoji collections that keep families in sync, make
              planning easier, and keep every trip on track.
            </p>
            <div className="flex flex-col gap-4 sm:flex-row">
              <Link
                href="/lists"
                data-testid="home-lists-link"
                className="btn-primary inline-flex items-center justify-center gap-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 cursor-pointer"
              >
                Start my lists
              </Link>
              <Link
                href="/history"
                data-testid="home-history-link"
                className="btn-secondary inline-flex items-center justify-center gap-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-secondary focus-visible:ring-offset-2 cursor-pointer"
              >
                View recent history
              </Link>
            </div>
          </div>

          <div className="relative">
            <div className="bento-card grid gap-6 p-6 sm:p-8">
              <div className="flex items-center justify-between rounded-2xl border border-border/60 bg-white/80 p-4 shadow-soft">
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">Next list</p>
                  <p className="font-heading text-2xl font-bold text-foreground">Weekend staples</p>
                </div>
                <div className="rounded-2xl bg-primary/10 px-3 py-2 text-sm font-semibold text-primary">
                  6 items
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-2xl border border-border/60 bg-white/80 p-4">
                  <p className="text-sm font-semibold text-muted-foreground">Shared with</p>
                  <p className="mt-2 font-heading text-xl font-bold text-foreground">Family</p>
                </div>
                <div className="rounded-2xl border border-border/60 bg-white/80 p-4">
                  <p className="text-sm font-semibold text-muted-foreground">Saved time</p>
                  <p className="mt-2 font-heading text-xl font-bold text-foreground">12 min</p>
                </div>
              </div>
              <div className="rounded-2xl bg-gradient-to-r from-primary/10 via-secondary/20 to-accent/20 p-4">
                <p className="text-sm font-semibold text-muted-foreground">Quick actions</p>
                <div className="mt-3 grid grid-cols-2 gap-2 text-sm font-semibold text-foreground">
                  <span className="rounded-xl bg-white/80 px-3 py-2 text-center">Add emoji</span>
                  <span className="rounded-xl bg-white/80 px-3 py-2 text-center">Share list</span>
                  <span className="rounded-xl bg-white/80 px-3 py-2 text-center">Mark done</span>
                  <span className="rounded-xl bg-white/80 px-3 py-2 text-center">Duplicate</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-20">
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="bento-card p-6">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Sparkles className="h-6 w-6" aria-hidden="true" />
            </div>
            <h2 className="mt-4 font-heading text-2xl font-bold text-foreground">
              Expressive lists
            </h2>
            <p className="mt-2 text-muted-foreground">
              Build lists that are easy to scan with visual emoji previews and quick actions.
            </p>
          </div>
          <div className="bento-card p-6">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-secondary/20 text-secondary">
              <LayoutGrid className="h-6 w-6" aria-hidden="true" />
            </div>
            <h2 className="mt-4 font-heading text-2xl font-bold text-foreground">
              Organized flows
            </h2>
            <p className="mt-2 text-muted-foreground">
              Keep categories, favorites, and history tightly connected so nothing gets missed.
            </p>
          </div>
          <div className="bento-card p-6">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/20 text-accent">
              <ShieldCheck className="h-6 w-6" aria-hidden="true" />
            </div>
            <h2 className="mt-4 font-heading text-2xl font-bold text-foreground">
              Reliable everywhere
            </h2>
            <p className="mt-2 text-muted-foreground">
              Use Clickmoji online or offline with fast sync and secure account access.
            </p>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-24">
        <div className="bento-card flex flex-col gap-6 bg-accent text-accent-foreground sm:flex-row sm:items-center sm:justify-between sm:p-10">
          <div>
            <h2 className="font-heading text-3xl font-bold">Ready for your next shop?</h2>
            <p className="mt-2 max-w-lg text-accent-foreground/90">
              Create a list in seconds and share it instantly with the people you shop with.
            </p>
          </div>
          <Link
            href="/lists"
            className="inline-flex items-center justify-center rounded-2xl bg-white px-6 py-3 text-base font-semibold text-accent shadow-soft transition-colors duration-200 hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-accent cursor-pointer"
          >
            Build my list
          </Link>
        </div>
      </section>
    </div>
  );
}
