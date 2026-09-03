// "Why I built this" — the founding post, expanded from Nico's thread on the
// software factory loop. Rendered by src/http/blog.tsx at /blog/software-factory.
import type { Post } from '../blog.tsx';

const LOOP = [
  {
    n: '01',
    label: 'Observe',
    lamp: 'off',
    body: 'Most signals that already exist: an error rate, a repeated support message, a page losing traffic, or some custom event.',
  },
  {
    n: '02',
    label: 'Diagnose',
    lamp: 'hold',
    body: 'From there, I have an agent inspect the signal against the real code and decide whether it is a bug, a regression, a gap, or just noise.',
  },
  {
    n: '03',
    label: 'Fix',
    lamp: 'hold',
    body: 'Before any code changes, I want a short plan with the files, acceptance criteria, and risks. Once approved, the agent builds the change in a sandbox and opens a PR.',
  },
  {
    n: '04',
    label: 'Test',
    lamp: 'hold',
    body: 'For testing, I run the repository checks and ask a separate agent to verify each criterion, including launching the app and taking screenshots.',
  },
  {
    n: '05',
    label: 'Deploy',
    lamp: 'off',
    body: "Deployment stays in the existing pipeline. The factory opens a normal PR and only merges when I allow it (merging can also be automated, but it's risky).",
  },
  {
    n: '06',
    label: 'Learn',
    lamp: 'off',
    body: 'After deployment, I check whether the original signal went away. That result helps me handle the next similar signal.',
  },
] as const;

export const softwareFactory: Post = {
  slug: 'software-factory',
  category: 'why I built this',
  title: 'Every software company will (eventually) run a software factory',
  dek: "No, software factories will not replace coding agents or deployment pipelines. I imagine a future where they co-exist; connected in a loop that turns signals into verified changes. That's what I'm building towards with Turbodiff.",
  published: '2026-09-02',
  author: {
    name: 'Nico Botha',
    role: 'creator, turbodiff',
    handle: 'Ngineer101',
    url: 'https://github.com/Ngineer101',
    x: 'https://x.com/nwbotha',
    image: 'https://avatars.githubusercontent.com/u/21199947?v=4&s=96',
    bio: 'Building Turbodiff, the software factory that builds itself. Writes about agents, proof, and building good software.',
  },
  tags: ['software factory', 'agents', 'proof of build'],
  sections: [
    {
      id: 'the-loop-is-people',
      heading: 'The loop I kept seeing',
      body: (
        <>
          <p>
            Looking at how production bugs get fixed today, I see the same sequence every time. An
            alert fires. Someone reads it in Slack, decides it is real, and opens a ticket. Another
            person reproduces the problem, writes a fix (most probably with the help of AI), waits
            for the checks, code review, merges, deploys, and watches the dashboard. And this cycle
            repeats weekly.
          </p>
          <p>
            To me, that is already a loop with clear inputs and outputs. The problem is that people
            are responsible for moving information between these tools: an alert becomes a Slack
            message, then a ticket, then a branch, then a PR. And while there is some value in
            having human judgement in the process, I don't think copying context from one tool to
            the next is a good use of anyone's time.
          </p>
          <p>
            My bet is that software teams will eventually run this loop as a system instead of
            relying on habit. That's where software factories come in. From my perspective, it does
            not replace coding agents, CI, deployment tools or human involvement. It augments the
            human loop and automates the repetitive tasks.
          </p>
        </>
      ),
    },
    {
      id: 'the-loop',
      heading: 'The loop I envision',
      body: (
        <>
          <p>
            The same six steps keep happening: observe, diagnose, fix, test, deploy, and learn. In
            practice, I imagine one pass looking like this:
          </p>
          <div class="loop" aria-label="the factory loop">
            {LOOP.map((s) => (
              <div key={s.n} class={s.lamp === 'hold' ? 'card live' : 'card'}>
                <div class="top">
                  <span class={s.lamp === 'hold' ? 'placard hot' : 'placard'}>
                    <span class={`lamp ${s.lamp}`} aria-hidden="true"></span>
                    {s.label}
                  </span>
                  <span class="n">{s.n}</span>
                </div>
                <p>{s.body}</p>
              </div>
            ))}
          </div>
          <p>
            Whenever a new signal arrives, I want the loop to run again instead of waiting for the
            next planning cycle. Turbodiff currently handles the three lit stages in the middle. The
            remaining ones are still on my list (to complete the entire factory loop).
          </p>
        </>
      ),
    },
    {
      id: 'not-only-bugs',
      heading: 'This is bigger than bugs',
      body: (
        <>
          <p>
            Error rates are a natural starting point because the manual loop is easy to see there.
            But the same approach will work for other things that can be measured and changed in
            code:
          </p>
          <ul>
            <li>
              <span>
                <strong>Analytics.</strong> When a funnel step drops after a release, I want to find
                the change that caused it, propose a fix, and check whether conversion recovers.
              </span>
            </li>
            <li>
              <span>
                <strong>Customer support.</strong> Twenty messages about the same confusing setting
                look like a product signal to me. The fix might be copy, a better default, or a
                small feature.
              </span>
            </li>
            <li>
              <span>
                <strong>SEO monitoring.</strong> When a page loses rank or a crawl report finds
                broken structured data, I want to trace the problem back to a concrete code change.
              </span>
            </li>
            <li>
              <span>
                <strong>Custom events.</strong> Any event I would normally ask a person to
                investigate is one the factory can look at first.
              </span>
            </li>
          </ul>
          <p>
            Either way, I still want the work to end in a normal PR. The goal is simply to automate
            more of the path from the first signal to that PR.
          </p>
        </>
      ),
    },
    {
      id: 'complements',
      heading: 'Keeping the tools that already work',
      body: (
        <>
          <p>
            This is not about replacing the tools that already work. Coding agents can write the
            code, CI can run the checks, and the existing pipeline can deploy it. What is missing is
            the connection between the different systems/tools: getting a signal, making a plan,
            checking the result, and leaving a useful record of what happened.
          </p>
          <p>
            That is the idea shaping Turbodiff. It checks out the real branch in a sandbox, runs the
            repository's own check command, and opens a normal PR (if needed). The reviewers, merge
            policy, and deployment all remain under my control.
          </p>
        </>
      ),
    },
    {
      id: 'proof',
      heading: 'Proof is the hard part',
      body: (
        <>
          <p>
            As soon as you remove people from the handoffs, you implicitly remove a lot of judgment
            from the process. So you need another way to trust the result. Reading every line of
            every generated change does not scale. A PR description written by the coding model does
            not count as evidence to me; it is still a claim from the same model.
          </p>
          <blockquote>
            <p>Anyone can generate code. We ship proof.</p>
            <cite>the line on the landing page, and the reason the product exists</cite>
          </blockquote>
          <p>
            That is why every Turbodiff feature gets a certificate with the approved plan, the diff,
            the check run, and screenshots for the acceptance criteria. This was the first part I
            built because the rest of the loop is not useful unless its output can be verified.
          </p>
        </>
      ),
    },
    {
      id: 'today',
      heading: 'What Turbodiff can do today',
      body: (
        <>
          <p>
            Currently, Turbodiff runs the middle of the loop: plan, build, verify, and ship. You
            describe a feature, an agent plans it against the repository, and you approve the plan.
            A sandbox builds it and opens a PR. An (automated) reviewer fixes what it finds, and a
            separate verifier adds screenshots before the merge. This is also how I build Turbodiff
            itself. Agents wrote roughly two thirds of the commits currently on its main branch.
          </p>
          <aside class="card note">
            <span class="lamp hold" aria-hidden="true"></span>
            <div>
              <span class="rail-label">note</span>
              <p>
                The repository stays public. When Turbodiff builds one of its own features, the
                plan, checks, and screenshots stay in the PR. Because the proof is in the pudding.
              </p>
            </div>
          </aside>
        </>
      ),
    },
    {
      id: 'what-i-believe',
      heading: 'What I believe',
      body: (
        <>
          <p>
            Today I still see people connecting alerts, Slack messages, tickets, emails, and PRs by
            hand. My bet is that much of this work will be automated in the next few years. Better
            models alone will not get us there. But with good integrations and verifications,
            automations get easier and more reliable.
          </p>
          <p>
            My goal is to build that system in the open, let teams run it on their own
            infrastructure, and leave enough evidence for them to judge the result.
          </p>
          <p>
            That is why I'm building Turbodiff. If it sounds like a loop you are running by hand,{' '}
            <a href="https://github.com/Ngineer101/turbodiff">star the repository</a>, or point it
            at a repo and let it build something for you.
          </p>
        </>
      ),
    },
  ],
};
