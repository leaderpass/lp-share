import { SignInForm } from '@/app/signin/SignInForm';

/** What someone sees when a share won't open for them (spec §2). */
export function Gate({ reason, next }: Readonly<{ reason: 'gone' | 'staff' | 'signin' | 'not-listed'; next: string }>) {
  const staffHref = `/staff/start?next=${encodeURIComponent(next)}`;
  return (
    <div className="shell">
      <div className="center">
        <div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="gate-logo" src="/share-logo.png" alt="LeaderPass" />
          {reason === 'gone' && (<>
            <h1>This link is no longer available</h1>
            <p>Ask your LeaderPass contact for a new one.</p>
          </>)}
          {reason === 'staff' && (<>
            <h1>This share is for LeaderPass staff</h1>
            <p>Open it with LPOS to continue.</p>
            <a className="btn btn-gold" href={staffHref}>Open with LPOS</a>
          </>)}
          {reason === 'signin' && (<>
            <h1>Sign in to view</h1>
            <p>This share is for specific people. Enter your email and we&rsquo;ll send you a secure link.</p>
            <SignInForm next={next} />
            <p className="gate-staff"><a href={staffHref}>LeaderPass staff</a></p>
          </>)}
          {reason === 'not-listed' && (<>
            <h1>This share isn&rsquo;t addressed to you</h1>
            <p>You&rsquo;re signed in with a different email. <a href="/api/auth/signout">Sign out</a> and use the email the share was sent to.</p>
            <p className="gate-staff"><a href={staffHref}>LeaderPass staff</a></p>
          </>)}
        </div>
      </div>
    </div>
  );
}
