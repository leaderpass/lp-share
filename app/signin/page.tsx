import { SignInForm } from './SignInForm';

export const dynamic = 'force-dynamic';

export default function SignInPage() {
  const demo = process.env.LINK_HUB_DEMO === '1';
  return (
    <div className="shell">
      <div className="center">
        <div>
          <div className="brand-title">LeaderPass <span>Videos</span></div>
          <h1>Sign in</h1>
          <p>Enter your email and we&rsquo;ll send a secure link. No password needed.</p>
          <SignInForm demo={demo} />
        </div>
      </div>
    </div>
  );
}
