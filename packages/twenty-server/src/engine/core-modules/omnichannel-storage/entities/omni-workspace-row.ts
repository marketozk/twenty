import {
  Column,
  CreateDateColumn,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from 'typeorm';

export abstract class OmniWorkspaceRow {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: false })
  workspaceId: string;

  @ManyToOne('WorkspaceEntity', { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({ name: 'workspaceId' })
  workspace: Relation<{ id: string }>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
