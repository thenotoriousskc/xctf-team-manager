import { TEAM_NAME, SCHOOL_LOGO } from '../config.ts'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl p-5 space-y-3">
      <h2 className="text-base font-bold text-navy-900">{title}</h2>
      {children}
    </div>
  )
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="w-6 h-6 rounded-full bg-navy-900 text-white text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">{n}</div>
      <p className="text-sm text-navy-700">{children}</p>
    </div>
  )
}

function Q({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-sm font-semibold text-navy-800">{q}</p>
      <p className="text-sm text-navy-600">{children}</p>
    </div>
  )
}

export function HelpPage() {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-navy-900 text-white px-4 py-4 flex items-center gap-3">
        <img src={SCHOOL_LOGO || '/team-logo.png'} alt="" className="h-8 w-8 rounded-full" />
        <div>
          <h1 className="text-lg font-bold">{TEAM_NAME}</h1>
          <p className="text-navy-300 text-xs">Help &amp; Support</p>
        </div>
      </header>

      <div className="max-w-lg mx-auto p-4 space-y-4">

        <Section title="Getting Started — Athletes">
          <Step n={1}>Open the app at <span className="font-mono text-navy-900">xctf-team.vercel.app</span></Step>
          <Step n={2}>Tap <strong>Sign in</strong> (top right) and sign in with your school Google account.</Step>
          <Step n={3}>The app will automatically jump to your workout card.</Step>
          <Step n={4}>Next time you open the app you'll go straight to your card — no sign-in needed.</Step>
        </Section>

        <Section title="Connecting Strava">
          <Step n={1}>Sign in with Google first (see above).</Step>
          <Step n={2}>On your workout card, tap <strong>Connect Strava</strong>.</Step>
          <Step n={3}>You'll be taken to Strava to authorize the app. Tap <strong>Authorize</strong>.</Step>
          <Step n={4}>You'll return to your card and see your mileage for this week and last week.</Step>
          <p className="text-xs text-navy-400 pl-9">Mileage updates every time you open the app.</p>
        </Section>

        <Section title="Your Workout Card">
          <Q q="What does the card show?">
            Today's workout assigned by your coach — including warmup, the main set, pace/effort guidance, and cooldown. Below that you'll see your weekly mileage (if Strava is connected), PRs from athletic.net, and past workouts.
          </Q>
          <Q q="The workout looks wrong or missing.">
            Tap the refresh button (↻) in the top right. If it's still wrong, check with your coach — the assignment may not have been saved yet.
          </Q>
          <Q q="How do I switch athletes?">
            Tap <strong>Switch</strong> in the top right to go back to the athlete picker.
          </Q>
        </Section>

        <Section title="Troubleshooting">
          <Q q="I signed in but it shows someone else's card.">
            Your Google account name doesn't exactly match the roster. Ask your coach to check the spelling of your name in the dashboard.
          </Q>
          <Q q="Connect Strava shows an error or doesn't work.">
            The app may have reached Strava's connection limit. Let your coach know — they'll need to request expanded access from Strava.
          </Q>
          <Q q="My mileage looks wrong.">
            Mileage counts runs logged on Strava since Monday midnight (Pacific time). Make sure your activities are set to a run type (Run, Trail Run, Treadmill) in Strava.
          </Q>
          <Q q="The app isn't loading or looks outdated.">
            Open your browser's settings and clear the site data for this app, then reload. On iOS, go to Settings → Safari → Advanced → Website Data and remove the entry.
          </Q>
          <Q q="I connected Strava but it shows — instead of miles.">
            Pull up Strava and make sure you have at least one run logged this week or last week. If runs are there and it still shows —, try the refresh button.
          </Q>
        </Section>

        <Section title="For Coaches">
          <Q q="How do I access the dashboard?">
            From the main screen open the menu and tap <strong>Coach</strong> (workouts, roster, mileage) or <strong>Stats</strong> (course leaderboards), then sign in with your Google account. Your email must be on the authorized coaches list.
          </Q>
          <Q q="Changes aren't saving.">
            Look for the "Saved" indicator in the dashboard header. If it shows an error, tap it to retry. Check your internet connection.
          </Q>
          <Q q="An athlete isn't seeing the right workout.">
            Make sure their name in the Roster tab matches exactly what they signed in with via Google (case-sensitive).
          </Q>
        </Section>

        <Section title="Contact">
          <p className="text-sm text-navy-700">
            Still stuck? Reach out to your coach.
          </p>
        </Section>

        <div className="text-center text-xs text-navy-400 pb-4">
          <a href="/" className="underline hover:text-navy-600">← Back to app</a>
        </div>

      </div>
    </div>
  )
}
