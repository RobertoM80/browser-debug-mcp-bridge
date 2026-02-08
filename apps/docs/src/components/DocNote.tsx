import React from 'react';
import Admonition from '@theme/Admonition';

type Props = {
  children: React.ReactNode;
  title?: string;
};

export function DocNote({ children, title = 'Note' }: Props): JSX.Element {
  return (
    <Admonition type="note" title={title}>
      {children}
    </Admonition>
  );
}
