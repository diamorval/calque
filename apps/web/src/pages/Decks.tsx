import {
  Button,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  PageHeader,
  PageHeaderActions,
  PageHeaderHeading,
  PageHeaderTitle,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@diametral/design-system/react";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { navigate } from "../nav.ts";

interface DeckRow {
  id: string;
  title: string;
  pack_id: string;
  head: number;
  updated_at: string;
}

export function Decks() {
  const [decks, setDecks] = useState<DeckRow[] | null>(null);
  useEffect(() => {
    api<{ decks: DeckRow[] }>("/api/decks").then((r) => setDecks(r.decks));
  }, []);

  return (
    <>
      <PageHeader>
        <PageHeaderHeading>
          <PageHeaderTitle>Decks</PageHeaderTitle>
        </PageHeaderHeading>
        <PageHeaderActions>
          <Button variant="primary" onClick={() => navigate("/new")}>
            New deck
          </Button>
        </PageHeaderActions>
      </PageHeader>
      {!decks && <Spinner label="Loading decks" />}
      {decks?.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No deck yet</EmptyTitle>
            <EmptyDescription>Describe the deck you need; the agent builds it on your company's brand pack.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="primary" onClick={() => navigate("/new")}>
              New deck
            </Button>
          </EmptyContent>
        </Empty>
      )}
      {!!decks?.length && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Brand pack</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {decks.map((d) => (
              <TableRow key={d.id}>
                <TableCell>
                  <Button variant="link" onClick={() => navigate(`/d/${d.id}`)}>
                    {d.title}
                  </Button>
                </TableCell>
                <TableCell>{d.pack_id}</TableCell>
                <TableCell>v{d.head}</TableCell>
                <TableCell>{new Date(d.updated_at).toLocaleString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
