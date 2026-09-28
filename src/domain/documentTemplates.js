import { templateDefaults } from './documents.js';

// A draft can follow the company's published default or pin an explicit template.
// List order is not a default, and an unpublished edit must not enter its preview.
export function resolveDocumentTemplate(templates, kind, templateId = '') {
  const published=(templates||[]).filter(template=>template.kind===kind&&template.published);
  const template=templateId?published.find(template=>template.id===templateId):published.find(template=>template.isDefault===true);
  return {
    template:template||null,
    id:template?.id||'',
    version:template?Number(templateId?(template.publishedVersion??template.version):(template.defaultVersion??template.publishedVersion??template.version)):0,
    settings:template?(template.publishedSettings||template.settings):templateDefaults(kind),
    unavailable:!!templateId&&!template,
  };
}
