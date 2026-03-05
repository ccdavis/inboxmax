import { Link, useNavigate } from 'react-router-dom';
import * as api from '../api';

export default function LandingPage({ user, onSignOut }) {
  const navigate = useNavigate();

  const handleSignOut = async () => {
    try {
      await api.signout();
    } catch {
      // Still clear local state even if API fails
    }
    onSignOut();
  };

  // Logged-in view
  if (user) {
    const name = user.display_name || user.email.split('@')[0];
    return (
      <div className="min-h-dvh bg-gradient-to-br from-slate-50 to-slate-100 flex flex-col">
        <header className="relative z-10 flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <span className="text-2xl font-bold bg-gradient-to-r from-indigo-500 to-violet-500 bg-clip-text text-transparent" aria-hidden="true">
              Μ
            </span>
            <span className="text-lg tracking-tight text-slate-900">
              <span className="font-light">Inbox</span>
              <span className="font-bold"> Max</span>
            </span>
          </div>
          <nav className="flex items-center gap-4" aria-label="User menu">
            <span className="text-sm text-slate-600 hidden sm:inline">{user.email}</span>
            <button
              onClick={handleSignOut}
              className="text-sm text-slate-400 hover:text-slate-600 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 rounded"
            >
              Sign out
            </button>
          </nav>
        </header>

        <main className="flex-1 flex flex-col items-center justify-center px-4">
          <h1 className="text-3xl font-light text-slate-800 mb-8">
            Welcome back, <span className="font-semibold">{name}</span>.
          </h1>
          <button
            onClick={() => navigate('/inbox')}
            className="px-8 py-4 bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-600 hover:to-violet-600 text-white text-lg font-semibold rounded-xl shadow-lg shadow-indigo-200 transition transform hover:scale-[1.02] focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
          >
            Take me to Inbox Max
          </button>
        </main>
      </div>
    );
  }

  // Anonymous landing page
  return (
    <div className="min-h-dvh bg-gradient-to-br from-slate-50 to-slate-100 flex flex-col">
      {/* Nav */}
      <header className="relative z-10 flex items-center justify-between px-6 py-4 md:px-10 md:py-5 lg:px-12 lg:py-6">
        <div className="flex items-center gap-2">
          <span className="text-2xl lg:text-3xl font-bold bg-gradient-to-r from-indigo-500 to-violet-500 bg-clip-text text-transparent" aria-hidden="true">
            Μ
          </span>
          <span className="text-lg lg:text-xl tracking-tight text-slate-900">
            <span className="font-light">Inbox</span>
            <span className="font-bold"> Max</span>
          </span>
        </div>
        <nav className="flex items-center gap-3 lg:gap-4" aria-label="Main navigation">
          <Link
            to="/signin"
            className="text-sm lg:text-base text-slate-600 hover:text-slate-900 transition px-3 py-2 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            Sign In
          </Link>
          <Link
            to="/register"
            className="text-sm lg:text-base font-medium text-white bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-600 hover:to-violet-600 px-4 py-2 lg:px-6 lg:py-2.5 rounded-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-indigo-500"
          >
            Get Started
          </Link>
        </nav>
      </header>

      {/* Hero */}
      <main>
        <section className="flex flex-col items-center justify-center px-4 pt-12 pb-16 md:pt-20 md:pb-24 lg:min-h-[92vh] lg:pt-0 lg:pb-0">
          <div className="text-7xl sm:text-8xl md:text-[10rem] lg:text-[14rem] leading-none font-bold bg-gradient-to-br from-indigo-500 to-violet-500 bg-clip-text text-transparent select-none" aria-hidden="true">
            Μ
          </div>

          <h1 className="text-4xl md:text-5xl lg:text-7xl tracking-tight text-slate-900 mt-4 lg:mt-6">
            <span className="font-light">Inbox</span>
            <span className="font-bold"> Max</span>
          </h1>
          <p className="text-xl md:text-2xl lg:text-4xl text-slate-500 mt-3 lg:mt-5 font-light">Maximum simplicity.</p>

          <p className="text-slate-500 mt-6 lg:mt-8 text-center max-w-lg lg:max-w-2xl leading-relaxed text-base md:text-lg lg:text-xl">
            The email client for people who read subject lines.
            <br />
            See what's new. Skip what's not. That's it.
          </p>

          <div className="flex flex-col sm:flex-row items-center gap-4 lg:gap-6 mt-10 lg:mt-14">
            <Link
              to="/register"
              className="px-8 py-3.5 lg:px-12 lg:py-5 bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-600 hover:to-violet-600 text-white font-semibold rounded-xl shadow-lg shadow-indigo-200 transition transform hover:scale-[1.02] text-lg lg:text-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
            >
              Get Started — It's Free
            </Link>
            <Link
              to="/signin"
              className="text-sm lg:text-base text-slate-500 hover:text-slate-700 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded px-3 py-2"
            >
              Already have an account? Sign in
            </Link>
          </div>
        </section>

        {/* Social proof / stats strip */}
        <section className="border-y border-slate-200/60 bg-white/50 py-8 md:py-10 lg:py-16" aria-label="Key benefits">
          <div className="max-w-4xl lg:max-w-5xl mx-auto grid grid-cols-1 sm:grid-cols-3 gap-6 lg:gap-10 px-6 text-center">
            <div>
              <p className="text-3xl lg:text-5xl font-bold text-indigo-600">0</p>
              <p className="text-sm lg:text-base text-slate-500 mt-1 lg:mt-2">Unread count anxiety</p>
            </div>
            <div>
              <p className="text-3xl lg:text-5xl font-bold text-indigo-600">30s</p>
              <p className="text-sm lg:text-base text-slate-500 mt-1 lg:mt-2">To check your email</p>
            </div>
            <div>
              <p className="text-3xl lg:text-5xl font-bold text-indigo-600">Any</p>
              <p className="text-sm lg:text-base text-slate-500 mt-1 lg:mt-2">IMAP provider works</p>
            </div>
          </div>
        </section>

        {/* Feature cards */}
        <section className="py-16 md:py-20 lg:py-28 px-6" aria-labelledby="features-heading">
          <h2 id="features-heading" className="text-2xl md:text-3xl lg:text-5xl font-bold text-slate-900 text-center mb-4 lg:mb-6">
            Email, without the noise
          </h2>
          <p className="text-slate-500 text-center max-w-lg lg:max-w-2xl mx-auto mb-12 lg:mb-16 lg:text-lg">
            Inbox Max shows you only what arrived since you last looked. No folders to organize, no categories to configure.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 lg:gap-8 max-w-4xl lg:max-w-5xl mx-auto">
            <article className="bg-white rounded-2xl border border-slate-200 p-6 md:p-8 lg:p-10 shadow-sm hover:shadow-md transition">
              <div className="w-10 h-10 lg:w-14 lg:h-14 rounded-lg bg-indigo-50 flex items-center justify-center mb-4 lg:mb-6">
                <svg className="w-5 h-5 lg:w-7 lg:h-7 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h3 className="font-semibold lg:text-lg text-slate-900 mb-2">Since Last Open</h3>
              <p className="text-slate-500 text-sm lg:text-base leading-relaxed">See only what's new since you last checked. No more scrolling through hundreds of old messages.</p>
            </article>
            <article className="bg-white rounded-2xl border border-slate-200 p-6 md:p-8 lg:p-10 shadow-sm hover:shadow-md transition">
              <div className="w-10 h-10 lg:w-14 lg:h-14 rounded-lg bg-amber-50 flex items-center justify-center mb-4 lg:mb-6">
                <svg className="w-5 h-5 lg:w-7 lg:h-7 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
                </svg>
              </div>
              <h3 className="font-semibold lg:text-lg text-slate-900 mb-2">Remember This</h3>
              <p className="text-slate-500 text-sm lg:text-base leading-relaxed">Star the emails that matter. Everything else fades away so you can focus on what counts.</p>
            </article>
            <article className="bg-white rounded-2xl border border-slate-200 p-6 md:p-8 lg:p-10 shadow-sm hover:shadow-md transition">
              <div className="w-10 h-10 lg:w-14 lg:h-14 rounded-lg bg-violet-50 flex items-center justify-center mb-4 lg:mb-6">
                <svg className="w-5 h-5 lg:w-7 lg:h-7 text-violet-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </div>
              <h3 className="font-semibold lg:text-lg text-slate-900 mb-2">Any Provider</h3>
              <p className="text-slate-500 text-sm lg:text-base leading-relaxed">Gmail, Outlook, Yahoo, Fastmail — connect any IMAP email server. Your data stays yours.</p>
            </article>
          </div>
        </section>

        {/* How it works */}
        <section className="py-16 md:py-20 lg:py-28 px-6 bg-white/50 border-t border-slate-200/60" aria-labelledby="how-heading">
          <h2 id="how-heading" className="text-2xl md:text-3xl lg:text-5xl font-bold text-slate-900 text-center mb-12 lg:mb-16">
            How it works
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-8 lg:gap-12 max-w-3xl lg:max-w-4xl mx-auto text-center">
            <div>
              <div className="w-12 h-12 lg:w-16 lg:h-16 rounded-full bg-indigo-100 text-indigo-600 font-bold text-lg lg:text-xl flex items-center justify-center mx-auto mb-4 lg:mb-6">1</div>
              <h3 className="font-semibold lg:text-lg text-slate-900 mb-1">Create an account</h3>
              <p className="text-sm lg:text-base text-slate-500">Sign up in seconds. No credit card, no catch.</p>
            </div>
            <div>
              <div className="w-12 h-12 lg:w-16 lg:h-16 rounded-full bg-indigo-100 text-indigo-600 font-bold text-lg lg:text-xl flex items-center justify-center mx-auto mb-4 lg:mb-6">2</div>
              <h3 className="font-semibold lg:text-lg text-slate-900 mb-1">Connect your email</h3>
              <p className="text-sm lg:text-base text-slate-500">Link any IMAP account. We auto-detect settings for popular providers.</p>
            </div>
            <div>
              <div className="w-12 h-12 lg:w-16 lg:h-16 rounded-full bg-indigo-100 text-indigo-600 font-bold text-lg lg:text-xl flex items-center justify-center mx-auto mb-4 lg:mb-6">3</div>
              <h3 className="font-semibold lg:text-lg text-slate-900 mb-1">See what's new</h3>
              <p className="text-sm lg:text-base text-slate-500">Only new emails since your last visit. Star what matters, skip the rest.</p>
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="py-16 md:py-24 lg:py-32 px-6 text-center" aria-label="Sign up call to action">
          <h2 className="text-2xl md:text-3xl lg:text-5xl font-bold text-slate-900 mb-4 lg:mb-6">
            Ready to simplify your inbox?
          </h2>
          <p className="text-slate-500 mb-8 lg:mb-10 max-w-md lg:max-w-lg mx-auto lg:text-lg">
            Join Inbox Max and spend less time in email. It takes less than a minute to get started.
          </p>
          <Link
            to="/register"
            className="inline-block px-8 py-3.5 lg:px-12 lg:py-5 bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-600 hover:to-violet-600 text-white font-semibold rounded-xl shadow-lg shadow-indigo-200 transition transform hover:scale-[1.02] text-lg lg:text-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
          >
            Get Started — It's Free
          </Link>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-200/60 py-8 px-6 text-center">
        <div className="flex items-center justify-center gap-2 mb-3">
          <span className="text-lg font-bold bg-gradient-to-r from-indigo-500 to-violet-500 bg-clip-text text-transparent" aria-hidden="true">Μ</span>
          <span className="text-sm text-slate-600">
            <span className="font-light">Inbox</span>
            <span className="font-semibold"> Max</span>
          </span>
        </div>
        <p className="text-xs text-slate-400">Maximum simplicity. Built for people who value their time.</p>
      </footer>
    </div>
  );
}
