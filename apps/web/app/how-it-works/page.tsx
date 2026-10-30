import type { Metadata } from 'next';
import { Card, PageHeader } from '@bsm/ui';

export const metadata: Metadata = { title: 'How it works' };

export default function HowItWorks() {
  return (
    <>
      <PageHeader title="How it works" subtitle="Three sides, one set of rules." />
      <Card title="Facilities">
        <ol>
          <li>Create an account and register your organization. BSM reviews it before you can post jobs; you can see the decision and the reason.</li>
          <li>Add facilities, locations and departments, and invite team members with the role they need.</li>
          <li>Post a job or shifts and list the licenses and certifications that are mandatory.</li>
          <li>Review applicants. Candidates who meet every mandatory requirement are ranked, with the reasons shown. Others are listed with exactly what is missing.</li>
          <li>Offers can only be sent to candidates who are currently eligible.</li>
        </ol>
      </Card>
      <Card title="Healthcare professionals">
        <ol>
          <li>Create an account, confirm your email, and build your profile.</li>
          <li>Add your licenses and certifications and upload documents. They are stored privately and visible only to you and to BSM credential reviewers.</li>
          <li>BSM reviewers record the outcome. You see the status and any request for more information.</li>
          <li>Search opportunities and apply directly. Optionally, turn on discoverability so approved facilities can find an anonymized summary of your profile and invite you to apply.</li>
        </ol>
      </Card>
      <Card title="Staffing agencies">
        <p>Agency onboarding, candidate consent and submissions are planned for a later release.</p>
      </Card>
      <Card title="What BSM does not do">
        <ul>
          <li>It does not employ professionals or act as a staffing agency.</li>
          <li>It does not guarantee placement, credential approval or coverage.</li>
          <li>It does not mark a credential verified until a reviewer has recorded how it was checked.</li>
        </ul>
      </Card>
    </>
  );
}
