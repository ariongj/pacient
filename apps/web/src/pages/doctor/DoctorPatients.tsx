import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { Page, PatientListItem } from '../../api/types';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorAlert,
  PageHeader,
  Pagination,
  QueryView,
  Tabs,
  TabPanel,
  Table,
  TextField,
} from '../../components/ui';
import { age, formatDate, fullName, humanize } from '../../format';
import { useChartRole } from './chart/shared';

type Scope = 'mine' | 'facility';

export function DoctorPatients() {
  const qc = useQueryClient();
  const { isDoctor, base } = useChartRole();
  const [scope, setScope] = useState<Scope>('mine');
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const list = useQuery({
    queryKey: ['patients', scope, search, page],
    queryFn: () =>
      api<Page<PatientListItem>>('/patients', { query: { scope, search, page, pageSize: 20 } }),
    placeholderData: keepPreviousData,
  });

  const join = useMutation({
    mutationFn: (id: string) => api(`/patients/${id}/care-team`, { method: 'POST', body: {} }),
    onSuccess: (_d, id) => {
      void qc.invalidateQueries({ queryKey: ['patients'] });
      void qc.invalidateQueries({ queryKey: ['patient', id] });
    },
  });

  function onSearch(e: FormEvent) {
    e.preventDefault();
    setPage(1);
    setSearch(draft.trim());
  }

  return (
    <>
      <PageHeader
        title="Patients"
        actions={
          isDoctor ? (
            <Link to="/doctor/patients/new" className="btn btn-primary btn-md">
              Register patient
            </Link>
          ) : undefined
        }
      />
      <Card>
        <Tabs<Scope>
          label="Patient list scope"
          active={scope}
          onChange={(s) => {
            setScope(s);
            setPage(1);
          }}
          tabs={[
            { id: 'mine', label: 'In my care' },
            { id: 'facility', label: 'Registered at my facility' },
          ]}
        />
        <TabPanel id={scope}>
          <form className="search-bar" onSubmit={onSearch} role="search">
            <TextField
              label="Search by name or national ID"
              type="search"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={100}
            />
            <Button type="submit">Search</Button>
            {search && (
              <Button
                variant="ghost"
                onClick={() => {
                  setDraft('');
                  setSearch('');
                  setPage(1);
                }}
              >
                Clear
              </Button>
            )}
          </form>
          {scope === 'facility' && (
            <p className="muted">
              Joining a patient’s care team gives you access to their record. It is recorded in the
              audit trail and shown to the patient in their access log.
            </p>
          )}
          <ErrorAlert error={join.error} />
          <QueryView query={list}>
            {(data) =>
              data.items.length === 0 ? (
                <EmptyState title="No patients found">
                  {search
                    ? 'Try a different name or national ID.'
                    : 'No patients in this list yet.'}
                </EmptyState>
              ) : (
                <>
                  <Table caption="Patients">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>National ID</th>
                        <th>Date of birth</th>
                        <th>Sex</th>
                        <th>Portal</th>
                        <th>Care</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((p) => (
                        <tr key={p.id}>
                          <td>
                            <Link to={`${base}/patients/${p.id}`}>
                              {p.lastName}, {p.firstName}
                            </Link>
                          </td>
                          <td>
                            <code>{p.nationalId}</code>
                          </td>
                          <td>
                            {formatDate(p.dateOfBirth)} ({age(p.dateOfBirth)} y)
                          </td>
                          <td>{humanize(p.sex)}</td>
                          <td>
                            {p.hasPortalAccount ? (
                              <Badge tone="success">Active</Badge>
                            ) : (
                              <Badge>None</Badge>
                            )}
                          </td>
                          <td>
                            {p.inMyCare ? (
                              <Badge tone="info">In my care</Badge>
                            ) : (
                              <Button
                                size="sm"
                                variant="secondary"
                                loading={join.isPending && join.variables === p.id}
                                onClick={() => join.mutate(p.id)}
                                aria-label={`Join care team of ${fullName(p)}`}
                              >
                                Join care team
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                  <p className="muted">{data.total} patient(s)</p>
                  <Pagination page={data.page} totalPages={data.totalPages} onChange={setPage} />
                </>
              )
            }
          </QueryView>
        </TabPanel>
      </Card>
    </>
  );
}
