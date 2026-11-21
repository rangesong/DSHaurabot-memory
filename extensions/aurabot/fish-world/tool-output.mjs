// Aurabot's default renderer only shows value.message (otherwise a bare check mark).
// Life tools must expose their structured receipts and approved arguments to the model.
export const renderLifeTool=(_args,value)=>[{type:'text',text:JSON.stringify(value??{ok:true})}];
