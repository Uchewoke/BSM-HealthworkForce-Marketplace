import { Card, LinkButton } from '@bsm/ui';

export default function Home() {
  return (
    <>
      <section className="hero">
        <h1>A healthcare workforce marketplace, built on clear rules</h1>
        <p className="muted" style={{ maxWidth: 720, fontSize: '1.1rem' }}>
          BSM HealthForce Marketplace is software that connects healthcare facilities with independent healthcare professionals.
          Facilities, professionals and (in a later release) staffing agencies keep their own business and contractual relationships;
          BSM supplies the marketplace and the workflow.
        </p>
        <div className="row">
          <LinkButton href="/register/professional">I am a professional</LinkButton>
          <LinkButton href="/register/facility">I represent a facility</LinkButton>
          <LinkButton href="/how-it-works" tone="secondary">How it works</LinkButton>
        </div>
        <p className="small muted">
          Already registered? <a href="/login/professional">Professional sign in</a> · <a href="/login/facility">Facility sign in</a>
        </p>
      </section>

      <div className="grid">
        <Card title="For facilities">
          <p>Register your organization, add locations and departments, invite your team, and post jobs and shifts with explicit license and certification requirements.
            Review applicants with a plain-language explanation of who meets each mandatory requirement, and invite professionals who have chosen to be discoverable.</p>
        </Card>
        <Card title="For healthcare professionals">
          <p>Build your profile, add licenses and certifications, and upload supporting documents privately. Search opportunities and apply directly to facilities.
            You decide whether facilities can find you, and you can change that at any time.</p>
        </Card>
        <Card title="For staffing agencies">
          <p>Agency features, including consent-based candidate representation, are planned for a later release. They are not available yet.</p>
        </Card>
      </div>

      <Card title="How credentials are shown">
        <p>Uploading a document does not make a credential verified. Every credential shows its real status, such as submitted, pending review, expired or verified,
          and a verified credential always states <em>how</em> it was checked: by document review, or against the primary source. Mandatory requirements are never overridden by search ranking.</p>
      </Card>

      <p className="small muted">
        BSM is a technology platform. It does not employ professionals, and it does not guarantee placement, credential approval or staffing coverage.
        Facilities and professionals are responsible for their own agreements and legal obligations.
      </p>
    </>
  );
}
