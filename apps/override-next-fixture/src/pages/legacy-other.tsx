import type { GetServerSideProps, InferGetServerSidePropsType } from 'next';

interface LegacyOtherSignal {
  mode: string;
  message: string;
  badge: string;
}

interface LegacyOtherPageProps {
  signal: LegacyOtherSignal;
}

export const getServerSideProps: GetServerSideProps<LegacyOtherPageProps> = async () => ({
  props: {
    signal: {
      mode: 'original-next-data-sibling',
      message: 'Original sibling Next data response.',
      badge: 'sibling-stable',
    },
  },
});

export default function LegacyOtherPage({ signal }: InferGetServerSidePropsType<typeof getServerSideProps>) {
  return (
    <main data-fixture-page="legacy-other">
      <p>Pages Router sibling data route</p>
      <h1 id="legacy-other-mode">{signal.mode}</h1>
      <p id="legacy-other-message">{signal.message}</p>
      <span id="legacy-other-badge">{signal.badge}</span>
    </main>
  );
}
