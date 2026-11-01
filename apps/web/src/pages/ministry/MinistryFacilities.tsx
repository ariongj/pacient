import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { Facility } from '../../api/types';
import {
  Badge,
  Button,
  Card,
  compact,
  Dialog,
  EmptyState,
  enumOptions,
  ErrorAlert,
  formValues,
  PageHeader,
  QueryView,
  SelectField,
  Table,
  TextField,
} from '../../components/ui';
import { humanize } from '../../format';

const FACILITY_TYPES = [
  'UNIVERSITY_CLINICAL_CENTER',
  'REGIONAL_HOSPITAL',
  'FAMILY_MEDICINE_CENTER',
  'SPECIALIZED_CLINIC',
] as const;

function FacilityForm({ facility, onDone }: { facility?: Facility; onDone: () => void }) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      facility
        ? api<Facility>(`/facilities/${facility.id}`, { method: 'PATCH', body })
        : api<Facility>('/facilities', { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['facilities'] });
      void qc.invalidateQueries({ queryKey: ['stats'] });
      onDone();
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const body = {
      ...compact({
        code: v.code,
        name: v.name,
        type: v.type,
        region: v.region,
        municipality: v.municipality,
      }),
      address: v.address || null,
      phone: v.phone || null,
    };
    mutation.mutate(body);
  }

  return (
    <form onSubmit={onSubmit}>
      <div className="form-grid">
        <TextField
          label="Code"
          name="code"
          required
          defaultValue={facility?.code}
          pattern="[A-Za-z0-9-]{2,32}"
          hint="Letters, digits and dashes, e.g. RH-FE"
        />
        <TextField label="Name" name="name" required minLength={2} defaultValue={facility?.name} />
        <SelectField
          label="Type"
          name="type"
          required
          options={enumOptions(FACILITY_TYPES)}
          defaultValue={facility?.type ?? 'FAMILY_MEDICINE_CENTER'}
        />
        <TextField
          label="Region"
          name="region"
          required
          minLength={2}
          defaultValue={facility?.region}
        />
        <TextField
          label="Municipality"
          name="municipality"
          required
          minLength={2}
          defaultValue={facility?.municipality}
        />
        <TextField label="Address" name="address" defaultValue={facility?.address ?? ''} />
        <TextField label="Phone" name="phone" type="tel" defaultValue={facility?.phone ?? ''} />
      </div>
      <ErrorAlert error={mutation.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={mutation.isPending}>
          {facility ? 'Save changes' : 'Create facility'}
        </Button>
      </div>
    </form>
  );
}

export function MinistryFacilities() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Facility | null>(null);

  const query = useQuery({
    queryKey: ['facilities', { search, includeInactive: true }],
    queryFn: () =>
      api<{ items: Facility[] }>('/facilities', { query: { search, includeInactive: true } }),
  });

  const toggle = useMutation({
    mutationFn: (f: Facility) =>
      api<Facility>(`/facilities/${f.id}`, { method: 'PATCH', body: { isActive: !f.isActive } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['facilities'] });
      void qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });

  return (
    <>
      <PageHeader
        title="Facilities"
        subtitle="Hospitals and health centres in the national network"
        actions={<Button onClick={() => setCreating(true)}>Add facility</Button>}
      />
      <Card>
        <form
          className="search-bar"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(formValues(e.currentTarget).search ?? '');
          }}
        >
          <TextField
            label="Search by name or code"
            name="search"
            type="search"
            defaultValue={search}
          />
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
        <ErrorAlert error={toggle.error} />
        <QueryView query={query}>
          {({ items }) =>
            items.length === 0 ? (
              <EmptyState title="No facilities found" />
            ) : (
              <Table caption="Facilities">
                <thead>
                  <tr>
                    <th scope="col">Facility</th>
                    <th scope="col">Type</th>
                    <th scope="col">Location</th>
                    <th scope="col">Phone</th>
                    <th scope="col">Status</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((f) => (
                    <tr key={f.id}>
                      <td>
                        <Link to={`/ministry/facilities/${f.id}`}>{f.name}</Link>
                        <div>
                          <code>{f.code}</code>
                        </div>
                      </td>
                      <td>{humanize(f.type)}</td>
                      <td>
                        {f.municipality}, {f.region}
                        {f.address && <div className="muted">{f.address}</div>}
                      </td>
                      <td>{f.phone ?? '—'}</td>
                      <td>
                        {f.isActive ? (
                          <Badge tone="success">Active</Badge>
                        ) : (
                          <Badge>Inactive</Badge>
                        )}
                      </td>
                      <td>
                        <div className="row">
                          <Button size="sm" variant="secondary" onClick={() => setEditing(f)}>
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={toggle.isPending && toggle.variables?.id === f.id}
                            onClick={() => toggle.mutate(f)}
                            aria-label={`${f.isActive ? 'Deactivate' : 'Activate'} ${f.name}`}
                          >
                            {f.isActive ? 'Deactivate' : 'Activate'}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )
          }
        </QueryView>
      </Card>

      <Dialog open={creating} onClose={() => setCreating(false)} title="Add facility" wide>
        <FacilityForm onDone={() => setCreating(false)} />
      </Dialog>
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={`Edit ${editing?.name ?? 'facility'}`}
        wide
      >
        {editing && (
          <FacilityForm key={editing.id} facility={editing} onDone={() => setEditing(null)} />
        )}
      </Dialog>
    </>
  );
}
