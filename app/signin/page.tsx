import { SignInForm } from './SignInForm';

export const dynamic = 'force-dynamic';

export default function SignInPage() {
  const demo = process.env.LINK_HUB_DEMO === '1';
  return (
    <div className="shell">
      <div className="center">
        <div>
          <div className="signin-brand">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/share-logo.png" alt="LeaderPass" />
            <span>Share</span>
          </div>
          <h1>Sign in</h1>
          <SignInForm demo={demo} hint={<>Enter your email and we&rsquo;ll send a secure link. No password needed.</>} />
        </div>
      </div>
    </div>
  );
}
