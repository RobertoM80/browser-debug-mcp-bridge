import type { GetServerSideProps, InferGetServerSidePropsType } from 'next';

interface LegacyLargeSignal {
  mode: string;
  message: string;
  badge: string;
}

interface LegacyLargePageProps {
  signal: LegacyLargeSignal;
  largePayload: string;
}

const LARGE_PAYLOAD_BYTES = 1_400_000;

export const getServerSideProps: GetServerSideProps<LegacyLargePageProps> = async () => ({
  props: {
    signal: {
      mode: 'original-large-next-data',
      message: 'Original large Next document response from Pages Router.',
      badge: 'pages-large-stable',
    },
    largePayload: 'L'.repeat(LARGE_PAYLOAD_BYTES),
  },
});

export default function LegacyLargePage({ signal }: InferGetServerSidePropsType<typeof getServerSideProps>) {
  return (
    <main data-fixture-page="legacy-large">
      <p>Pages Router large document route</p>
      <h1 id="legacy-large-mode">{signal.mode}</h1>
      <p id="legacy-large-message">{signal.message}</p>
      <span id="legacy-large-badge">{signal.badge}</span>
    </main>
  );
}
